# `membot` — Standalone AI-Agent Context Store

## What this project is

A standalone Bun CLI + MCP server (Bun package `membot`, binary
`membot`) that gives AI agents a persistent, versioned, searchable
context store. Files (markdown, PDF, DOCX, HTML, URLs, agent-authored
notes) are ingested, converted to markdown, chunked, embedded
**locally** with `@huggingface/transformers` (WASM, 384-dim
`Xenova/bge-small-en-v1.5`), and indexed in DuckDB with hybrid search
(semantic vector + BM25). Every agent-visible artifact is a row in
`files`, addressed by a virtual `logical_path` — there is **no**
on-disk tree of stored content.

## Goals

- **Local everything.** Embeddings run on the user's machine; data
  lives in `~/.membot/index.duckdb`. No cloud embedding APIs ever.
- **Append-only versioning.** Every ingest, refresh that finds new
  bytes, write, or rename creates a new `(logical_path, version_id)`
  row. `version_id` is a `TIMESTAMP` (ms precision). Default queries
  flow through `current_files` / `current_chunks` views; delete is a
  tombstone, not a row removal.
- **One mental model for every artifact.** Markdown, PDF, image,
  audio, anything — converts to a markdown surrogate that flows
  through the same chunk → embed → FTS pipeline. Original bytes live
  in `blobs`, reachable via `membot_read bytes=true`.
- **Two surfaces, one source of truth.** Each user-facing capability
  is a single `Operation` in `src/operations/` with zod input + output
  schemas; the CLI (commander) and MCP server both consume that —
  description text, `--help` output, and `tools/list` output never
  drift apart.
- **Native conversion first, LLM fallback for messy input.** `unpdf`
  for PDFs, `mammoth` for DOCX, `turndown` for HTML, Tesseract WASM
  for image OCR. Claude vision captions images and Claude markdown-
  conversion is the last-resort fallback. Missing
  `ANTHROPIC_API_KEY` is not a hard error — degrades to deterministic
  surrogates.
- **Embedded images become inline captions.** DOCX and HTML conversion
  intercept embedded images (mammoth's `convertImage` callback;
  `<img src="data:…">` extraction for HTML), keep their bytes out of
  the markdown body, and run each one through `convertImage` (Claude
  vision + Tesseract OCR). The caption is spliced back in place of the
  original image reference as its own paragraph block, so embedded
  diagrams/screenshots become real searchable text instead of megabytes
  of base64 noise. `converters.max_inline_image_captions` (default 20)
  caps the per-document fan-out.
- **Bun-compiled standalone binaries** for darwin/linux/windows ×
  arm64/x64. Runtime must not require Bun installed.
- **Stdio + HTTP MCP server** exposing every operation as a tool, plus
  a refresh daemon for scheduled re-fetches.

## Fetcher / downloader architecture

Remote URLs flow through a per-service downloader registry rather
than a generic agent loop. Each downloader knows its target service's
canonical export endpoint (or API), authenticates with whatever
mechanism that service actually accepts, and returns bytes for the
existing native converter pipeline. The persisted `(downloader,
downloader_args)` columns let `membot refresh` replay the exact same
downloader against the original URL — deterministic, no LLM, no
agent.

```
membot_add <url>
  ↓
findDownloader(url) → Downloader  (always returns one — generic-web is the catch-all)
  ↓
downloader.download(url, ctx) → bytes + mime + downloader_args
  ↓
existing mime-dispatched converter (unchanged)
  ↓
chunk → embed → store with persisted (downloader, downloader_args)
```

### Per-service strategies

| Downloader | Match | Strategy | Auth |
|---|---|---|---|
| `google-docs` | `docs.google.com/document/d/<id>` | `?format=docx` export → `convertDocx` | Cookies from persistent chromium profile |
| `google-sheets` | `docs.google.com/spreadsheets/d/<id>` | `?format=html` export → `convertHtml` | Same profile |
| `google-slides` | `docs.google.com/presentation/d/<id>` | `/export/pdf` → `convertPdf` | Same profile |
| `github` | `github.com/<owner>/<repo>/(issues\|pull)/<n>` | `api.github.com/repos/.../issues/<n>` + `/comments` → render JSON to markdown | `downloaders.github.api_key` PAT (or `GITHUB_TOKEN`); public repos work unauth at 60 req/hr |
| `linear` | `linear.app/<workspace>/issue/<KEY>` and `…/project/<slug>` | `api.linear.app/graphql` queries → render JSON to markdown | `downloaders.linear.api_key` personal API key |
| `generic-web` | catch-all for any http(s) URL | Plain GET (mime-dispatched) or Playwright `page.pdf()` for `text/html` (so SPAs and auth-walled pages work) | Cookies from the persistent profile |

Google fetches use Node's built-in `fetch()` with a `Cookie` header
read from the chromium profile. Playwright's `APIRequestContext` has
a known cookie-parser bug on Google's same-origin redirect Set-Cookie
headers; bypassing it via Node fetch sidesteps the crash. GitHub and
Linear are pure HTTP — they don't open chromium at all. Only Google
and generic-web touch the BrowserPool.

### Auth flow: one interactive step + non-interactive fetches

`membot login` is the **only** place a browser opens. It launches
chromium against the persistent profile at
`~/.membot/auth/browser-profile/` and points it at a small intro page
(rendered from `src/commands/login-page.mustache` using each
downloader's declared `LoginEntry`s). The user signs into the browser-
based services in that window, copies API keys for the token-based
services into a terminal, and closes the window. Cookies +
localStorage + IndexedDB land in the profile.

After that, every `membot add` and `membot refresh` runs strictly
non-interactively. Auth failures throw `HelpfulError` with a concrete
next step:
- Cookie services (Google) → "Run `membot login`."
- Token services (GitHub, Linear) → "Run `membot config set
  downloaders.<svc>.api_key <KEY>`."

The refresh daemon depends on this property — it runs unattended and
must never block on a browser window.

## Data model

```sql
CREATE TABLE files (
  logical_path    TEXT NOT NULL,
  version_id      TIMESTAMP NOT NULL DEFAULT now(),
  tombstone       BOOLEAN NOT NULL DEFAULT FALSE,
  source_type     TEXT NOT NULL,                        -- 'local' | 'remote' | 'inline'
  source_path     TEXT,                                 -- absolute path or full URL
  source_mtime_ms BIGINT,
  source_sha256   TEXT,                                 -- raw source bytes
  blob_sha256     TEXT,                                 -- → blobs(sha256)
  content_sha256  TEXT,                                 -- markdown surrogate
  content         TEXT,                                 -- markdown surrogate
  description     TEXT,                                 -- short, generated per-version
  mime_type       TEXT,
  size_bytes      BIGINT,
  fetcher         TEXT,                                 -- 'downloader' | 'local' | 'inline'
  downloader      TEXT,                                 -- e.g. 'google-docs', NULL for non-remote
  downloader_args JSON,                                 -- e.g. { document_id: '...' } — replayable on refresh
  refresh_frequency_sec INTEGER,
  refreshed_at    TIMESTAMP,
  last_refresh_status TEXT,
  change_note     TEXT,
  created_at      TIMESTAMP NOT NULL DEFAULT now(),
  PRIMARY KEY (logical_path, version_id)
);

CREATE TABLE blobs (
  sha256     TEXT PRIMARY KEY,
  mime_type  TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  bytes      BLOB NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE chunks (
  logical_path  TEXT NOT NULL,
  version_id    TIMESTAMP NOT NULL,
  chunk_index   INTEGER NOT NULL,
  chunk_content TEXT NOT NULL,                          -- raw body (clean snippets)
  search_text   TEXT NOT NULL,                          -- '<path>\n<description>\n\n<body>' (embedded + FTS)
  embedding     FLOAT[384] NOT NULL,
  PRIMARY KEY (logical_path, version_id, chunk_index)
);

CREATE VIEW current_files   AS …;  -- latest non-tombstoned per logical_path
CREATE VIEW current_chunks  AS …;
```

Migrations live in `src/db/migrations/`; every applied migration logs
an `info` line on first open so users can see what changed across
upgrades.

## Project layout

```
src/
  cli.ts                # commander entry; iterates operations registry
  sdk.ts                # programmatic API for embedding membot
  context.ts            # AppContext: config + db + logger + progress
  constants.ts          # MEMBOT_HOME, EMBEDDING_DIMENSION=384, FILES.BROWSER_PROFILE, defaults
  operations/           # ★ one file per user-facing capability — single source of truth
    types.ts            # Operation<I,O>, defineOperation()
    index.ts            # ordered registry; cli + mcp both iterate this
    add.ts list.ts tree.ts read.ts write.ts search.ts remove.ts
    move.ts refresh.ts info.ts versions.ts diff.ts prune.ts
  mount/
    mcp.ts              # mountAsMcpTool — registers an Operation as an MCP tool
    commander.ts        # mountAsCommanderCommand — registers an Operation as a CLI subcommand
    zod-to-cli.ts       # zod → commander .argument()/.option()
  commands/             # CLI-only (no MCP equivalent)
    login.ts            # opens chromium for one-time auth setup
    serve.ts reindex.ts config.ts skill.ts ...
    login-page.mustache # rendered into the membot-login intro page
  config/               # zod schema + loader (~/.membot/config.json)
  db/                   # DuckDB connection, migrations, files.ts, chunks.ts, blobs.ts
  ingest/
    source-resolver.ts  # file / dir / glob / url / inline detection
    local-reader.ts
    fetcher.ts          # downloader registry dispatch
    chunker.ts embedder.ts describer.ts search-text.ts
    converter/          # pdf, docx, html, image, text, ocr, llm
    downloaders/
      index.ts          # Downloader interface, findDownloader, listDownloaders, collectLoginEntries
      browser.ts        # BrowserPool (persistent chromium profile)
      google-docs.ts google-sheets.ts google-slides.ts google-shared.ts
      github.ts linear.ts generic-web.ts
  search/               # semantic.ts, keyword.ts, hybrid.ts (RRF)
  refresh/              # runner.ts, scheduler.ts (daemon)
  mcp/                  # server.ts, instructions.ts
  output/               # tty.ts, logger.ts, progress.ts, formatter.ts
  errors.ts             # HelpfulError — the only error type allowed in handlers
test/
patches/                # @huggingface/transformers WASM patch
scripts/
  apply-patches.sh
docs/plan.md            # this file
```

## CLI surface

```
membot login                                       # one-time auth setup (browser sign-in + API-key instructions)
membot add <sources...> [-p <path>] [-r <dur>] [--downloader <name>] [-m <note>]
membot ls [prefix]
membot tree [prefix] [--max-depth N] [--max-items N]
membot read <path> [--version <id>] [--bytes]
membot search <query> [--include-history]
membot info <path> [--version <id>]
membot versions <path>
membot diff <path> <a> [b]
membot write <path>
membot mv <from> <to>
membot rm <paths...>
membot refresh [path] [--force]
membot prune --before <ts>
membot serve [--http <port>] [--watch] [--tick <sec>]
membot reindex
membot config <get|set|unset|list|path>
membot skill install [--claude] [--cursor] [--global]
```

Global flags: `-c/--config`, `-j/--json`, `-v/--verbose`,
`--no-color`, `--no-interactive`. JSON output is automatic when piped
or when `CI=true`.

## Config (`~/.membot/config.json`)

```jsonc
{
  "data_dir": "~/.membot",
  "embedding_model": "Xenova/bge-small-en-v1.5",
  "embedding_dimension": 384,
  "chunker": { "mode": "deterministic", "target_chars": 4000, "max_chars": 15000 },
  "converters": { "max_inline_image_captions": 20 },         // per-doc cap on vision captions for embedded images
  "ingest": { "describer_concurrency": 5 },                  // max concurrent describe/convert workers per add
  "llm": {
    "anthropic_api_key": "",                                  // env: ANTHROPIC_API_KEY
    "converter_model": "claude-haiku-4-5-20251001",
    "chunker_model":   "claude-haiku-4-5-20251001",
    "describer_model": "claude-haiku-4-5-20251001",
    "vision_model":    "claude-haiku-4-5-20251001",
    "describer_skip_when_titled": true                        // skip LLM when markdown has a clear H1 in the opening
  },
  "downloaders": {
    "linear": { "api_key": "" },                              // linear.app/settings/api
    "github": { "api_key": "" }                               // env: GITHUB_TOKEN; or github.com/settings/tokens
  },
  "daemon": { "tick_interval_sec": 60 },
  "default_refresh_frequency_sec": null
}
```

Secrets (anything tagged `secret: true` in the zod schema) are stored
with file mode `0600` and masked by `membot config list`.

## Build & distribution

- Pre-build: `scripts/apply-patches.sh` applies the
  `@huggingface/transformers` WASM patch.
- Build: `bun build --compile --minify --sourcemap --external
  '@duckdb/*' --external 'playwright*' ./src/cli.ts --outfile
  dist/membot`. Both `@duckdb/*` and `playwright*` are externalized:
  - `@duckdb/node-bindings` ships per-platform `.node` files that
    `bun build --compile` can't bundle.
  - Playwright depends on a separately-installed Chromium binary at
    `~/.cache/ms-playwright/`.
- Targets: darwin-arm64, darwin-x64, linux-arm64, linux-x64,
  windows-x64, windows-arm64.
- Install: `bun add -g membot && bunx playwright install chromium`.
- Auto-release: incrementing `version` in `package.json` triggers the
  GitHub Action that builds and publishes binaries to a release.

## Testing

- `bun test`. Test preload at `test/_preload.ts` applies the
  transformers WASM patch (idempotent).
- DB-touching code uses real ephemeral DuckDB files, not mocks.
- Real fixtures for converters (`test/fixtures/sample.pdf`,
  `sample.docx`, `sample.html`).
- Live-network E2E tests at
  `test/ingest/downloaders-e2e.test.ts` hit `www.evantahler.com` (the
  generic-web → page.pdf path) and `github.com/evantahler/membot/issues/36`
  (the github REST path). Skipped when chromium isn't installed or
  when `MEMBOT_SKIP_E2E=1`.
- Versioning paths to cover: insert creates v1, refresh-unchanged
  creates no new version, refresh-changed creates v2, `current_files`
  returns v2, explicit `version=v1` returns v1, tombstone hides from
  `current_files` but `versions` still lists it, `prune --before`
  drops non-current rows.

## Things to avoid

- Re-introducing a filesystem store under `~/.membot/context/`. The
  store is rows.
- Cloud embeddings. Local WASM only.
- Mutating an existing version's `content` / `content_sha256` /
  `chunks`. Those fields are immutable once the row is written —
  corrections are new versions.
- Routing fetches through an LLM/agent. Refresh re-invokes the
  persisted downloader by name; deterministic, no Anthropic call.
- Opening a browser window during a fetch. `membot add` and
  `membot refresh` MUST stay non-interactive. Browser windows only
  open inside `membot login`.
- Throwing bare `new Error(...)` anywhere in handlers. Always
  `HelpfulError` with a concrete actionable hint. Wrap external errors
  with `asHelpful(cause, context, hint, kind)`.
- Embedding `chunk_content` raw. Always embed `search_text` (the
  prepended `<path>\n<description>\n\n<body>`).
- A separate `membot_read_blob` tool. Bytes are reachable via
  `membot_read bytes=true`. One read tool, one mental model.
- Defining a tool description in two places. If you're writing copy
  in `src/commands/...` that an MCP tool would also want, make it an
  `Operation` instead.
- Hand-rolling JSON Schema for an MCP tool. Always derive it from the
  zod input schema via the mount adapter.
