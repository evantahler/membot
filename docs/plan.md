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
  in `blobs`, reachable via `membot_read bytes=true` — except when
  ingest deliberately skipped persisting them (config
  `blobs.max_size_bytes`, default 25 MB; `blobs.skip_mime_types`,
  default `video/*` / `audio/*`). The `blobs` row itself is always
  written (sha256, mime, size, downloader provenance) so dedupe,
  refresh, and conversion-at-ingest-time still work; only the `bytes`
  column is left NULL. Single predicate `shouldPersistBlobBytes` in
  `src/ingest/blob-policy.ts` is the source of truth, consulted by
  both fresh ingest and `membot prune --strip-blob-bytes` (which
  retroactively NULLs bytes on rows that would fail the current
  policy).
- **Two surfaces, one source of truth.** Each user-facing capability
  is a single `Operation` in `src/operations/` with zod input + output
  schemas; the CLI (commander) and MCP server both consume that —
  description text, `--help` output, and `tools/list` output never
  drift apart.
- **Native conversion only for binaries.** `unpdf` for PDFs, `mammoth`
  for DOCX, `xlsx` (SheetJS) for XLSX, `jszip` + `fast-xml-parser` for
  PPTX, `turndown` for HTML. Claude vision captions embedded images and
  Claude markdown-conversion normalizes structured text (JSON / YAML /
  CSV / etc.). Opaque binaries we don't recognize return a deterministic
  `(unknown binary, ...)` placeholder — never a base64-sample LLM
  round-trip, because that path reliably hallucinated content from the
  filename. Missing `ANTHROPIC_API_KEY` is not a hard error — degrades
  to deterministic surrogates.
- **Embedded images become inline captions.** DOCX and HTML conversion
  intercept embedded images (mammoth's `convertImage` callback;
  `<img src="data:…">` extraction for HTML), keep their bytes out of
  the markdown body, and run each one through `convertImage` (Claude
  vision). The caption is spliced back in place of the original image
  reference as its own paragraph block, so embedded
  diagrams/screenshots become real searchable text instead of megabytes
  of base64 noise. `converters.max_inline_image_captions` (default 20)
  caps the per-document fan-out.
- **Parallel ingest pipeline.** A pMap worker pool (default `cpus - 1`,
  capped at `MAX_WORKERS = 8`) runs the full per-file pipeline (read →
  unchanged check → convert → describe → chunk → embed → persist) end-
  to-end. The persist phase is gated by an `AsyncMutex` so concurrent
  workers don't trip DuckDB's single-writer constraint. Embed is
  offloaded to a `Bun.Worker` pool — each worker hosts its own
  transformers feature-extraction pipeline (own ONNX session, own model
  weights), giving real OS-thread parallelism on the WASM step instead
  of contending for one shared extractor on the main JS thread. A
  multi-line stderr live area shows one status row per active worker
  plus the total bar, ETA, and cumulative chunk count.
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
findDownloader(url) → Downloader  (or null → HelpfulError pointing at `membot add <local-path>`)
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
| `github` | `github.com/<owner>/<repo>/(issues\|pull)/<n>` | `api.github.com/repos/.../issues/<n>` + `/comments` → render JSON to markdown | `downloaders.github.api_key` PAT (or `GITHUB_TOKEN`); public repos work unauth at 60 req/hr |
| `linear` | `linear.app/<workspace>/issue/<KEY>` and `…/project/<slug>` | `api.linear.app/graphql` queries → render JSON to markdown | `downloaders.linear.api_key` personal API key |
| `custom-command` | user-defined: `downloaders.custom_routers[*].url_pattern` (regex with named groups) | `Bun.spawn` the user's configured argv with `{var}` placeholders substituted from named groups, capture stdout, run an optional post-processor (built-in: `passthrough` / `docmd` / `html-to-markdown`; or a second `Bun.spawn` whose stdin gets piped in) | user-owned — the spawned command (e.g. `mcpx`, `gws`, `gh`, a private script) handles its own auth |

There is **no** generic-web catch-all and **no** built-in Google
plugin. Arbitrary http(s) URLs that no plugin (built-in or
user-registered) claims produce a clear `HelpfulError` instructing
the user to either register a router via `membot router add` or
download the file locally and `membot add <path>`.

Google Docs/Sheets/Slides are not a first-class source: Google's
OAuth scope policy makes the Drive-readonly entry tax
disproportionate (you either grant `cloud-platform` to gcloud or
manage your own GCP project + OAuth client). Two supported paths
instead:

1. **Export + ingest**: from Drive `File → Download → .docx`/`.xlsx`/`.pdf`
   and `membot add <path>`. The existing DOCX/XLSX/PDF converters
   render the content identically to a hypothetical Drive-API ingest.
   Auto-refresh is lost; everything else is the same.
2. **Custom router**: register a `custom-command` router that
   delegates the fetch to a tool that already has Google auth — e.g.
   `mcpx exec GoogleDocs_GetDocumentAsDocmd --doc-id {doc_id}`. Auth
   stays in the external tool; membot just spawns it and post-processes
   the output. `membot refresh` replays the exact same command.

GitHub, Linear, and custom routers' primary fetches are pure HTTP /
argv-`Bun.spawn` — they don't open a shell, never interpolate strings
into a command line, and never prompt. Membot itself opens **no**
browser, embeds **no** browser, and ships **no** bundled third-party
CLI. The user's machine supplies whatever shell commands their custom
routers reference.

### Custom URL routers

`custom-command` is the only `dynamic`-match plugin in the registry
(see `MatchSpec` in `src/ingest/sources/types.ts`). Its `matches`
function reads the live `config.downloaders.custom_routers` array at
dispatch time and tests each `url_pattern` regex in registration
order; first hit wins. Built-in URL plugins always win over dynamic
matchers — `findSourceForInput` runs dynamic matches only after every
static URL pattern fails, so a user pattern as broad as `^https://`
never steals a `github.com/...` URL from the `github` plugin.

Each row stores `downloader = "custom-command"` and
`downloader_args = { router: <name>, vars: { <captured> } }`. Refresh
looks up the live router by name (HelpfulError on missing — the
config row was deleted), substitutes the persisted vars back into the
argv template, and re-spawns the same command. The captured `vars`
are persisted, so a router whose `url_pattern` changes after ingest
still refreshes existing rows correctly (the new pattern is only
consulted on fresh ingests, not on replay).

Routers are validated at config-load time (compilable regex, no
placeholder references unknown named groups, unique names within the
array). The CLI surface is `membot router {add,list,remove,test}` in
`src/commands/router.ts`; the on-disk shape under
`downloaders.custom_routers` is the single source of truth so editing
`~/.membot/config.json` by hand also works.

### Auth flow: print instructions + non-interactive fetches

`membot login` is informational only — it walks every registered
plugin's `LoginEntry` (today: GitHub + Linear, both `api_key`) and
prints the settings URL plus the `membot config set` command for each
one. The user pastes the command into a terminal.

Every `membot add` and `membot refresh` runs strictly non-
interactively. Auth failures throw `HelpfulError` with a concrete
next step:
- Token services (GitHub, Linear) → "Run `membot config set
  downloaders.<svc>.api_key <KEY>`."

The refresh daemon depends on this property — it runs unattended and
must never block on a prompt.

## Apple Notes ingest

`apple-notes:<scope>` is a fourth `ResolvedSource` kind alongside
`inline`, `url`, and `local-files`. The scope syntax mirrors filesystem
globs: `apple-notes:[<account-glob>[/<folder-glob>]]`, e.g.
`apple-notes:Personal/Recipes/**`. `picomatch` (already a project dep)
handles matching.

The underlying transport is the [`macos-ts`](https://www.npmjs.com/package/macos-ts)
package, which opens `~/Library/Group Containers/group.com.apple.notes/NoteStore.sqlite`
directly via `bun:sqlite`, walks Apple's CoreData schema, and decodes
each note's gzip'd protobuf body to markdown in-process. No
AppleScript, no `osascript` subprocess, no browser — just a fast local
SQLite read. macOS-only; non-darwin platforms throw a `HelpfulError`
at the resolver boundary.

```
membot add "apple-notes:Personal/Recipes/**"
  ↓
source-resolver detects `apple-notes:` prefix
  ↓
parseAppleNotesScope → { accountPattern, folderPattern }
  ↓
openAppleNotes() opens reader (macos-ts → bun:sqlite)
  ↓
enumerateNotes walks accounts × folders × notes, picomatch-filtered
  ↓
ResolvedSource { kind: "apple-notes", entries: EnumeratedNote[] }
  ↓
ingestAppleNotesEntries: pMap worker pool
  per note:
    fast-path unchanged check: source_mtime_ms === note.modifiedAt
    fetchEnumeratedNote(reader, noteId) → markdown
    describe → chunk → embed → persist
  ↓
persist row: downloader="apple-notes",
            downloader_args={noteId, accountName, folderName, title},
            source_type="remote",
            source_path="apple-notes://note/<noteId>"
```

`refreshAppleNote` (in `src/refresh/runner.ts`) is a hard branch in
`refreshOne` that dispatches on `downloader === "apple-notes"`. It
opens a reader, replays `fetchNoteForRefresh(reader, noteId)`, and
re-runs describe → chunk → embed → persist. No converter call (the
markdown is already markdown). A `NoteNotFoundError` becomes a
`HelpfulError` pointing the user at `--sync`.

`--sync` (on `membot add apple-notes:...`) tombstones every current
`apple-notes/*` row inside the scope whose `noteId` is missing from
the live enumeration. Scope-aware so a narrow add doesn't tombstone
notes outside its filter.

Permissions: requires Full Disk Access for the host process.
`macos-ts`'s `DatabaseAccessDeniedError` is mapped to a `HelpfulError`
whose hint names the exact System Settings pane to open. The single
interactive recovery is the user toggling the permission in
System Settings — not a flow we control.

Out of scope for v1 (called out in `--help`, skill docs, README):
attachments, password-protected notes (skipped per-entry), shared-note
participants, two-way sync, iCloud-only notes not synced down,
hashtags / pinned state / smart folders, automatic refresh
(`refresh_frequency_sec` is not set by default).

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
  downloader      TEXT,                                 -- e.g. 'github', NULL for non-remote
  downloader_args JSON,                                 -- e.g. { owner, repo, number } — replayable on refresh
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
  bytes      BLOB,                                       -- nullable: ingest may skip persisting bytes (config blobs.max_size_bytes / blobs.skip_mime_types)
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE chunks (
  logical_path  TEXT NOT NULL,
  version_id    TIMESTAMP NOT NULL,
  chunk_index   INTEGER NOT NULL,
  chunk_content TEXT NOT NULL,                          -- raw body (clean snippets)
  search_text   TEXT NOT NULL,                          -- '<path>\n<description>\n<breadcrumb>\n\n<body>' (embedded + FTS)
  embedding     FLOAT[384] NOT NULL,
  context       TEXT,                                   -- heading breadcrumb ('Doc > Section'), NULL for non-markdown / preamble
  PRIMARY KEY (logical_path, version_id, chunk_index)
);

CREATE TABLE meta (                                     -- store-level key/value facts (not rows)
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,                             -- e.g. embedding_revision = '2'
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE VIEW current_files   AS …;  -- latest non-tombstoned per logical_path
CREATE VIEW current_chunks  AS …;
```

Migrations live in `src/db/migrations/`; every applied migration logs
an `info` line on first open so users can see what changed across
upgrades.

`meta.embedding_revision` tracks the embedding scheme (pooling mode +
chunk sizing + `search_text` shape) the stored vectors were built under.
A fresh DB is seeded at the current revision; an upgrade that changes the
scheme bumps the code constant (`EMBEDDING_REVISION`) so search warns once
and the user runs `membot reindex --embeddings` to re-embed in place.

## Search

Three-stage pipeline: **retrieve → fuse → (optionally) rerank**, then
diversify.

1. **Retrieve** (`semantic.ts` + `keyword.ts`). The semantic side embeds
   the query with the same bi-encoder used at ingest and ranks chunks by
   cosine distance over `current_chunks.embedding`. A bi-encoder encodes
   the query and each chunk *independently* into fixed 384-dim vectors, so
   retrieval is a cheap precomputed-vector scan over the whole store — but
   the model never sees a query and a chunk together, which caps precision.
   The keyword side is DuckDB FTS BM25 over `search_text`. Each returns a
   ranked list.
2. **Fuse** (`hybrid.ts`). Reciprocal-rank fusion merges the two lists
   (weighted by `search.semantic_weight`); snippets are centered on the
   matched query terms; results are capped per file (`search.max_per_file`)
   with backfill so the caller still gets `limit` hits.
3. **Rerank** (`rerank.ts`, opt-in). A **cross-encoder** runs the query and
   one candidate chunk through the model *jointly* and emits a single
   relevance score. Joint attention captures relevance a bi-encoder's
   independent encoding can't, but it can't be precomputed — one forward
   pass per `(query, chunk)` pair — so it's run only over the fused
   shortlist (top ~30), not the store. This retrieve-then-rerank split buys
   bi-encoder recall over everything plus cross-encoder precision on the
   finalists; it most helps hard/ambiguous queries where several chunks are
   topically close. Off by default (latency + a first-call model download);
   toggled by `search.rerank` or the per-query `--rerank` / MCP `rerank`.

## Project layout

```
src/
  cli.ts                # commander entry; iterates operations registry
  sdk.ts                # programmatic API for embedding membot
  context.ts            # AppContext: config + db + logger + progress
  constants.ts          # MEMBOT_HOME, EMBEDDING_DIMENSION=384, GWS_VERSION, defaults
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
    login.ts            # prints `membot config set` instructions for every api_key source
    serve.ts reindex.ts config.ts skill.ts ...
  config/               # zod schema + loader (~/.membot/config.json)
  db/                   # DuckDB connection, migrations, files.ts, chunks.ts, blobs.ts, meta.ts (embedding_revision)
  ingest/
    source-resolver.ts  # file / dir / glob / url / inline detection
    local-reader.ts
    fetcher.ts          # source plugin registry dispatch
    chunker.ts embedder.ts embedder-pool.ts embed-worker.ts describer.ts search-text.ts
    concurrency.ts      # pMap (worker-pool with stable workerId) + AsyncMutex
    converter/          # pdf, docx, xlsx, pptx, html, image, text, llm
    sources/
      index.ts          # side-effect plugin imports
      registry.ts       # registerSource, findSourceForInput, collectLoginEntries
      types.ts          # SourcePlugin, PluginCtx, LoginEntry shapes
      github.ts linear.ts apple-notes.ts
  search/               # semantic.ts, keyword.ts, hybrid.ts (weighted RRF + per-file diversity + centered snippets), rerank.ts (local cross-encoder)
  refresh/              # runner.ts, scheduler.ts (daemon)
  mcp/                  # server.ts, instructions.ts
  output/               # tty.ts, logger.ts, progress.ts, formatter.ts
  errors.ts             # HelpfulError — the only error type allowed in handlers
test/
  fixtures/eval/        # corpus + golden queries for the search-quality eval
patches/                # @huggingface/transformers WASM patch
scripts/
  apply-patches.sh
  eval-search.ts        # search-quality eval harness (Recall@k / MRR / answer@3); `--ci` gates CI
docs/plan.md            # this file
```

## CLI surface

```
membot login                                       # one-time auth setup (browser sign-in + API-key instructions)
membot add <sources...> [-p <path>] [-r <dur>] [--downloader <name>] [-m <note>]
membot ls [prefix]
membot tree [prefix] [--max-depth N] [--max-items N]
membot read <path> [--version <id>] [--bytes]
membot search <query> [--rerank] [--include-history]
membot info <path> [--version <id>]
membot versions <path>
membot diff <path> <a> [b]
membot write <path>
membot mv <from> <to>
membot rm <paths...>
membot refresh [path] [--force]
membot prune --before <ts>
membot serve [--http <port>] [--watch] [--tick <sec>]
membot reindex [--embeddings] [--recovery]
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
  "chunker": { "mode": "deterministic", "target_chars": 1400, "max_chars": 1800, "markdown_aware": true },  // sizes budgeted against bge-small's 512-token window; markdown_aware splits at headings + adds breadcrumbs
  "embedding": { "workers": null },                          // embed-subprocess pool size; null → cpus()-1, 1 runs inline
  "converters": { "max_inline_image_captions": 20 },         // per-doc cap on vision captions for embedded images
  "ingest": { "worker_concurrency": null },                  // pMap orchestration parallelism for the ingest pipeline; null → cpus()-1, max MAX_WORKERS=8
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
  "search": {
    "semantic_weight": 0.6,                                   // RRF weight on the semantic list (keyword gets 1 - this); 0.5 = equal, 0 = keyword-only, 1 = semantic-only
    "rerank": false,                                          // rescore fused candidates with a local cross-encoder (per-query: --rerank / MCP rerank param)
    "rerank_model": "Xenova/ms-marco-MiniLM-L-6-v2",          // cross-encoder used when rerank is on
    "max_per_file": 3                                         // cap hits per logical_path in results (0 = unlimited; backfills to keep `limit` hits)
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
  '@duckdb/*' --external 'macos-ts' ./src/cli.ts --outfile
  dist/membot`. `@duckdb/*` is externalized because DuckDB's `.node`
  bindings can't be embedded by `bun build --compile`; `macos-ts`
  is externalized because it uses Apple-specific native bindings.
- Targets: darwin-arm64, darwin-x64, linux-arm64, linux-x64,
  windows-x64, windows-arm64.
- Install: `bun add -g membot`. No postinstall step, no bundled
  third-party binaries.
- Auto-release: incrementing `version` in `package.json` triggers the
  GitHub Action that builds and publishes binaries to a release.

## Testing

- `bun test`. Test preload at `test/_preload.ts` applies the
  transformers WASM patch (idempotent).
- DB-touching code uses real ephemeral DuckDB files, not mocks.
- Real fixtures for converters (`test/fixtures/sample.pdf`,
  `sample.docx`, `sample.html`).
- Live-network E2E test at
  `test/ingest/downloaders-e2e.test.ts` hits
  `github.com/evantahler/membot/issues/36` (the github REST path).
  Skipped when `MEMBOT_SKIP_E2E=1`.
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
- Opening a browser or prompting on stdin during a fetch. `membot add`
  and `membot refresh` MUST stay non-interactive. `membot login` is
  informational only (no subprocess, no prompt).
- Re-introducing Playwright or any embedded browser. All current
  plugins are pure HTTP (GitHub, Linear) or pure local (Apple Notes).
- Adding native Google Docs/Sheets/Slides ingest. Users export from
  Drive as `.docx`/`.xlsx`/`.pdf` and `membot add <path>`.
- Throwing bare `new Error(...)` anywhere in handlers. Always
  `HelpfulError` with a concrete actionable hint. Wrap external errors
  with `asHelpful(cause, context, hint, kind)`.
- Embedding `chunk_content` raw. Always embed `search_text` (the
  prepended `<path>\n<description>\n<breadcrumb>\n\n<body>`, with the
  description capped so the whole string fits bge-small's 512-token
  window).
- Mean-pooling a BGE model. BGE-v1.5 is trained for CLS pooling
  (`resolvePooling` in `embedder.ts`); mean pooling silently degrades
  retrieval. Sizing chunks past the 512-token window is the same class
  of bug — the tail of the chunk never reaches the vector.
- Changing the embedding scheme (pooling / chunk sizing / `search_text`
  shape) without bumping `EMBEDDING_REVISION` and adding a history line.
  The bump is what tells existing stores to `reindex --embeddings`.
- A separate `membot_read_blob` tool. Bytes are reachable via
  `membot_read bytes=true`. One read tool, one mental model.
- Defining a tool description in two places. If you're writing copy
  in `src/commands/...` that an MCP tool would also want, make it an
  `Operation` instead.
- Hand-rolling JSON Schema for an MCP tool. Always derive it from the
  zod input schema via the mount adapter.
