# membot

> Versioned context store with hybrid search for AI agents. Stdio + HTTP MCP server and CLI.

[![npm](https://img.shields.io/npm/v/membot.svg)](https://www.npmjs.com/package/membot)
[![license](https://img.shields.io/github/license/evantahler/membot.svg)](./LICENSE)

`membot` is a single-binary CLI and MCP server that gives AI agents a persistent, versioned, searchable context store. Files (markdown, PDFs, DOCX, XLSX, PPTX, HTML, URLs, agent-authored notes) are ingested, converted to markdown, chunked, embedded **locally** with `@huggingface/transformers` (WASM, no cloud calls), and indexed in DuckDB with hybrid search (semantic vector + BM25). Every change creates a new version — nothing is overwritten in place.

- **Local everything** — embeddings run on your machine; data lives in `~/.membot/index.duckdb`.
- **One mental model** — every artifact (markdown, PDF, image, audio) becomes a markdown surrogate that flows through the same chunk → embed → search pipeline.
- **Append-only versioning** — every ingest, refresh, or write creates a new `(logical_path, version_id)` row. History is queryable; nothing is mutated.
- **Parallel ingest** — directory/glob ingests run a worker pool (default `cpus - 1`, max 8) with a `Bun.Worker` per slot for the WASM embed step, so a `~/notes/**/*.md` import actually uses your cores. The TTY shows one status line per active worker plus an ETA and a running chunk total.
- **Two surfaces, one source of truth** — every operation is exposed identically as a CLI subcommand and an MCP tool. The agent sees `membot_search`; you see `membot search`.

## Install

```bash
bun install -g membot
```

DuckDB's per-platform native bindings are pulled in by the install. No browser/Chromium dep.

After installing, see what auth (if any) the configured sources need:

```bash
membot login
```

Today's source plugins are either API-key (GitHub, Linear) or no auth (Apple Notes, local files). `membot login` prints the settings URL where you create a token and the `membot config set …` command to run in your terminal:

```bash
# GitHub: settings/tokens → fine-grained, repo:read
membot config set downloaders.github.api_key <PAT>
# or read from environment
export GITHUB_TOKEN=<PAT>

# Linear: linear.app/settings/api → personal API key
membot config set downloaders.linear.api_key <KEY>
```

Public GitHub repos work without a token (rate-limited at 60 req/hr). Linear always needs a key.

> **Google Docs / Sheets / Slides.** Not supported natively — the OAuth dance to get Drive scope on Google's terms is disproportionate (it requires either granting `cloud-platform` to `gcloud` or setting up your own GCP project + OAuth client). Workaround: in Google Drive, `File → Download → Microsoft Word (.docx)` (or `.xlsx` / `.pdf` for Sheets/Slides), then `membot add ./that-file.docx`. The PDF/DOCX/XLSX converters handle the content the same way they would have if we fetched it directly.

### Supported sources

The set of URL patterns and scheme prefixes `membot add` accepts is driven by a plugin registry. Run `membot sources` to inspect the live set on your install. The table below is auto-generated from the registry — adding a new plugin updates it here automatically.

<!-- AUTO-GENERATED:sources -->

| Plugin | Auth | Examples | Notes |
| --- | --- | --- | --- |
| **github**<br>GitHub issues & PRs — uses the GitHub REST API (with optional token for private repos). | `api_key` — `membot config set downloaders.github.api_key <PAT>` | `https://github.com/<owner>/<repo>/issues/<n>`<br>`https://github.com/<owner>/<repo>/pull/<n>` | Public repos work unauthenticated at 60 req/hr. For private repos or higher limits, configure a token: `membot config set downloaders.github.api_key <PAT>` or export `GITHUB_TOKEN`. |
| **github-repo**<br>GitHub repository bulk import — open issues and PRs (selectable, optionally including closed) via the GitHub REST API. | `api_key` — `membot config set downloaders.github.api_key <PAT>` | `github-repo:facebook/react`<br>`github-repo:owner/repo:issues`<br>`github-repo:owner/repo:prs:all`<br>`github-repo:owner/repo:all` | Default selector pulls open issues + open PRs. Override with `:issues`, `:prs`, `:issues:all`, `:prs:all`, `:all`. Uses the same API key as the per-URL github plugin (`membot config set downloaders.github.api_key <PAT>` or `GITHUB_TOKEN`). Pass --sync to tombstone items no longer returned by the enumerate; with an open-only selector, closing an item will tombstone it — use `:all` selectors to keep closed items. |
| **linear**<br>Linear issues & projects — uses the Linear GraphQL API with a personal access key. | `api_key` — `membot config set downloaders.linear.api_key <KEY>` | `https://linear.app/<workspace>/issue/<KEY>`<br>`https://linear.app/<workspace>/project/<slug>` | Requires a personal API key from https://linear.app/settings/api. Set it via `membot config set downloaders.linear.api_key <KEY>`. |
| **linear-team**<br>Linear team bulk import — every project under a team plus every issue in those projects, via the Linear GraphQL API. | `api_key` — `membot config set downloaders.linear.api_key <KEY>` | `linear-team:ENG`<br>`linear-team:DESIGN` | Same API key as the per-URL linear plugin (`membot config set downloaders.linear.api_key <KEY>`). Team key is the uppercase prefix of issue IDs (e.g. ENG from ENG-42). Pass --sync to tombstone projects/issues that have been deleted from Linear. |
| **apple-notes** _(darwin only)_<br>Apple Notes (macOS) — scope-driven import via NoteStore.sqlite. Markdown comes straight from the protobuf body. | none | `apple-notes:`<br>`apple-notes:Personal/Recipes`<br>`apple-notes:*/Archive`<br>`apple-notes:Personal/Recipes/**` | Requires Full Disk Access for your terminal in System Settings → Privacy & Security. Password-protected notes and Recently Deleted are skipped. Pass `--sync` to tombstone rows whose notes have been deleted. |

<!-- /AUTO-GENERATED:sources -->

### Apple Notes (macOS)

`apple-notes:` reads `NoteStore.sqlite` directly via [`macos-ts`](https://www.npmjs.com/package/macos-ts) — no AppleScript, no browser. Grant **Full Disk Access** to your terminal/editor in System Settings → Privacy & Security → Full Disk Access (one time). The scope after the colon supports the same glob syntax as filesystem paths:

```bash
membot add "apple-notes:"                          # all notes
membot add "apple-notes:Personal"                  # one account
membot add "apple-notes:Personal/Recipes"          # one folder
membot add "apple-notes:Personal/Recipes/**"       # one folder + nested subfolders
membot add "apple-notes:*/Inbox"                   # folder name "Inbox" in any account
membot add "apple-notes:**/Archive/**"             # anything under any "Archive" folder
membot add "apple-notes:Personal" --sync           # also tombstone rows for notes deleted in Notes.app
```

Each note's body is rendered to markdown by `macos-ts` (decoded from the gzip'd protobuf), then flows through the standard chunk → embed → search pipeline. Notes land at `apple-notes/<account>/<folder>/<title>.md`. Refresh re-fetches via the persisted `noteId` and skips re-embedding when `modifiedAt` is unchanged. `Recently Deleted` is excluded from wildcard scopes — name it explicitly (`apple-notes:iCloud/Recently Deleted`) to include the trash.

Out of scope for v1: attachments, password-protected notes (skipped per-entry), shared-note participants, two-way sync, iCloud-only notes not synced to this Mac.

### Custom URL routers

Need to ingest a URL that no built-in plugin claims? Register a **custom router** that dispatches matched URLs to an external shell command — useful when the URL's auth lives in another tool (`mcpx`, `gws`, `gcloud`, `gh`, a private script). The router persists the captured ID variables on each row so refresh replays the same command against the same source.

Google Docs example (delegates to `mcpx exec`, which already has Google auth wired up via the user's mcpx config):

```bash
membot router add \
  --name google-docs \
  --url-pattern '^https://docs\.google\.com/document/d/(?<doc_id>[a-zA-Z0-9_-]+)' \
  --command mcpx \
  --args 'exec,GoogleDocs_GetDocumentAsDocmd,--doc-id,{doc_id}' \
  --mime-type text/markdown \
  --post-process docmd
```

Then ingest as normal:

```bash
membot add https://docs.google.com/document/d/<doc-id>/edit
```

How it works:

- `--url-pattern` is a JS regex. Named groups `(?<name>...)` become `{name}` substitution variables; `{url}` substitutes the full source URL.
- `--command` + `--args` form an argv array — no shell, no string interpolation. The user-supplied doc id can't escape its argv slot.
- `--mime-type` declares what the command emits; it flows through the existing converter pipeline (markdown stays markdown, HTML routes through Turndown, etc.).
- `--post-process` runs after the primary fetch:
  - **passthrough** (default) — no transform.
  - **docmd** — light cleanup for Google's docmd output (smart-quote/NBSP normalization, blank-line collapse).
  - **html-to-markdown** — Turndown.
  - Or pass `--post-process-command <cmd>` + `--post-process-args <csv>` to pipe the bytes through any external script (`pandoc`, `jq`, etc.). The bytes arrive on the command's stdin; its stdout becomes the post-processed bytes. **You are opting into running this command on every ingest and every refresh.**

Manage routers:

```bash
membot router list                                 # table of configured routers
membot router test https://docs.google.com/.../   # show which router would match + extracted vars (no spawn)
membot router test https://docs.google.com/.../ --exec   # also run the spawn + post-process and print stdout
membot router remove google-docs                  # delete a router (warns if stored rows still reference it)
```

Built-in plugins (github, linear, apple-notes) always win on overlapping URL patterns — custom routers only fire when no built-in claims the URL. Routers live under `downloaders.custom_routers` in `~/.membot/config.json`; editing the file by hand works too.

Custom routers are the answer for Google Docs/Sheets/Slides today (see [issue #80](https://github.com/evantahler/membot/issues/80) for why a native plugin isn't): bring your own fetch command — `mcpx`, `gws`, `gh`, or whatever already has auth — and let membot handle the chunking, embedding, versioning, and refresh.

## Quick start

```bash
membot login                                     # see API-key setup instructions for GitHub / Linear
membot add ./docs                                # ingest a directory recursively
membot add ./drive-export.docx                   # for Google Docs/Sheets/Slides: export from Drive and add the file
membot add https://github.com/o/r/issues/123     # GitHub issues + PRs (with comments)
membot add https://linear.app/w/issue/ABC-12     # Linear issues + projects
membot add ./local-copy.pdf                      # any other web content: download locally and add the file
membot add "github-repo:cli/cli:issues"          # bulk-import every open issue in a repo
membot add "linear-team:ENG"                     # bulk-import every project + issue in a Linear team
membot add "apple-notes:Personal/Recipes"        # Apple Notes (macOS-only); see "Apple Notes" below
membot add a.md b.md "docs/**/*.md"              # any number of files / globs in one call
membot ls                                        # list current files
membot search "how does refresh work?"           # hybrid search
membot read docs/refresh.md                      # read the markdown surrogate
membot serve                                     # expose the same operations as MCP tools (stdio)
```

## Use with Claude Code or Cursor

`membot skill install` drops the agent skill into the right place so Claude Code or Cursor know **when** to call `membot`.

```bash
membot skill install --claude              # writes ./.claude/skills/membot.md (project)
membot skill install --cursor              # writes ./.cursor/rules/membot.mdc (project)
membot skill install --claude --global     # writes ~/.claude/skills/membot.md
membot skill install --claude --cursor -f  # both, overwrite if present
```

The skill files describe the discover → ingest → search → read → write workflow and the versioning rules. You can re-run with `--force` to refresh after upgrading membot.

## Commands

| Command                         | Description                                                                       |
| ------------------------------- | --------------------------------------------------------------------------------- |
| `membot add <sources...>`       | Ingest one or more files, directories, globs, URLs, `apple-notes:<scope>` (macOS), or `inline:<text>`. Default `logical_path` mirrors the source (absolute path for local files, `remotes/{host}/{path}` for URLs, `apple-notes/<account>/<folder>/<title>.md` for notes) so files with the same basename in different projects don't collide. Pass `-p <path>` to override or set a prefix. Skips unchanged source bytes; pass `--force` to re-ingest. For `apple-notes:` sources, pass `--sync` to tombstone rows whose underlying note was deleted in Notes.app. |
| `membot ls [prefix]`            | List current files (size, mime, refresh status)                                   |
| `membot tree [prefix]`          | Render the synthesised logical-path tree (`--max-depth`, `--max-items` cap output) |
| `membot read <path>`            | Read the markdown surrogate (or `--bytes` for original bytes, base64)             |
| `membot search <query>`         | Hybrid search (semantic + BM25); `--include-history` searches older versions      |
| `membot info <path>`            | Inspect metadata (source, fetcher, schedule, digests) without content             |
| `membot stats [prefix]`         | Summarize the index (file/version/chunk/blob counts, on-disk size, refresh health, mime/source/downloader breakdowns); optional prefix scopes the aggregates |
| `membot versions <path>`        | List every version newest-first                                                   |
| `membot diff <path> <a> [b]`    | Unified diff between two versions                                                 |
| `membot write <path>`           | Write inline agent-authored markdown as a new version                             |
| `membot mv <from> <to>`         | Rename a logical_path (history preserved under both)                              |
| `membot rm <paths...>`          | Tombstone one or more logical_paths or globs (e.g. `"docs/**/*.md"`); pass `-r` / `--recursive` to remove a directory prefix; history kept |
| `membot refresh [path]`         | Re-read source; new version only if bytes changed                                 |
| `membot prune --before <ts>`    | Permanently drop non-current versions older than cutoff (irreversible). Add `--strip-blob-bytes` to also retroactively NULL out bytes for blobs that exceed the current `blobs.max_size_bytes` / `blobs.skip_mime_types` policy. |
| `membot serve`                  | Run the MCP server (stdio default; `--http <port>` for HTTP)                      |
| `membot logs`                   | Print or tail the serve-mode audit log (`~/.membot/logs/serve.log`) — `--follow`, `--lines <N>`, `--raw` |
| `membot reindex`                | Rebuild the FTS keyword index over current chunks                                 |
| `membot config <subcommand>`    | Get / set values in `~/.membot/config.json` (`get`, `set`, `unset`, `list`, `path`) |
| `membot router <subcommand>`    | Manage user-defined URL routers (`add`, `list`, `remove`, `test`) — see [Custom URL routers](#custom-url-routers) |
| `membot login`                  | Print one-time auth setup instructions (today: `membot config set` commands for GitHub / Linear) |
| `membot skill install`          | Install the Claude Code / Cursor agent skill                                      |

Run `membot <command> --help` for full flags and arguments. Every command produces JSON when piped, when `--json` is set, or when `CI=true`.

## MCP server

`membot serve` exposes every operation as an MCP tool. Stdio is the default; pass `--http <port>` for streamable HTTP.

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "membot": {
      "command": "membot",
      "args": ["serve"]
    }
  }
}
```

**Streamable HTTP** (any MCP client that speaks HTTP):

```bash
membot serve --http 3000
# tool endpoint: http://localhost:3000/mcp
```

Add `--watch` (and optional `--tick <sec>`) to also run the refresh daemon, which re-reads any file whose `refresh_frequency` has elapsed.

### Logs

`membot serve` writes a structured audit log to `~/.membot/logs/serve.log` — one JSON record per line — capturing every MCP tool invocation (tool name, argument keys, duration, result size, and any error kind + hint) plus refresh-daemon ticks. Argument values and result bodies are **never** written, so the log stays safe to share. The file rolls over at 5 MB (3 files retained).

```bash
membot logs                    # pretty-print the last 100 lines
membot logs --lines 1000       # more history
membot logs --follow           # tail -F for live viewing
membot logs --raw | jq '.tool' # raw JSON lines for programmatic use
```

## Programmatic use

The same package ships a TypeScript SDK so you can drive every operation directly from another Bun app — handy for embedding membot in a custom agent loop, a Slack bot, or another CLI. One method per CLI verb / MCP tool, schema-validated I/O, lazy connect.

```ts
import { MembotClient } from "membot";

const client = new MembotClient();
await client.add({ sources: ["inline:hello world"], logical_path: "scratch/hello.md" });
const hits = await client.search({ query: "hello" });
await client.close();
```

See [`docs/sdk.md`](./docs/sdk.md) for the full method list, error model, and lower-level primitives (`buildContext`, `OPERATIONS`, `ingest`, `searchSemantic`, …) for callers that need to bypass the client.

## Configuration

- **Data directory:** `~/.membot/` (override with `MEMBOT_HOME=/path` or `--config <path>`).
  - `~/.membot/index.duckdb` — all content, blobs, chunks, embeddings, and metadata.
  - `~/.membot/models/` — cached embedding model weights (`Xenova/bge-small-en-v1.5`, 384-dim).
  - `~/.membot/logs/serve.log` — structured audit log written by `membot serve`. One JSON record per line; tail it with `membot logs --follow`. Rolls over at 5 MB; 3 files retained.
- **Config file:** `~/.membot/config.json` (optional; defaults are sane). Edit it directly or via `membot config`:

  ```bash
  membot config list                                            # show every value (secrets masked)
  membot config set llm.anthropic_api_key sk-ant-...            # enable LLM-fallback paths
  membot config set chunker.target_chars 800                    # tweak any nested value
  membot config set embedding.workers 4                         # cap parallel embed workers
  membot config set search.semantic_weight 0.6                  # tilt hybrid-search RRF toward semantic (default 0.6; 0.5 = equal, 0 = keyword-only, 1 = semantic-only)
  membot config set converters.max_inline_image_captions 50     # raise per-doc cap on vision captions for embedded images
  membot config set blobs.max_size_bytes 26214400               # 25 MB; skip persisting bytes for sources larger than this (null = always persist)
  membot config set blobs.skip_mime_types '["video/*","audio/*"]' # mime globs whose bytes are never persisted regardless of size
  membot config set ingest.worker_concurrency 4                 # cap parallel ingest workers (default: cpus-1, max 8)
  membot config set llm.describer_skip_when_titled false        # always LLM-describe (default true skips when markdown has a clear H1)
  membot config get llm.anthropic_api_key --show-secrets        # reveal the masked key
  membot config unset chunker.target_chars                      # back to schema default
  membot config path                                            # print the absolute config path
  ```

  **Parallel embedding:** `embedding.workers` (default `null` → `cpus()-1`) controls how many subprocess workers fan out the WASM embedding work. The pool is **per-command** — spawned at the start of `add` / `refresh` / `write` and killed before the command returns, so membot doesn't keep idle workers around between invocations. Each worker loads its own ~50MB copy of the model, so on RAM-constrained machines drop it to a small fixed number (e.g. `4`); set `1` to disable the pool entirely and embed inline.

  **Hybrid-search ranking:** `search.semantic_weight` (default `0.6`, range `[0, 1]`) controls reciprocal-rank fusion between the semantic and keyword sides. The semantic list contributes weight `semantic_weight`; keyword contributes `1 - semantic_weight`. The default tilts slightly toward semantic so a chunk that matches a query conceptually (without literal token overlap) can outrank docs that incidentally contain a query word. Set to `0.5` to restore equal weighting, `0.0` for keyword-only ranking behaviour, or `1.0` for semantic-only. Search-time queries also get the BGE-v1.5 instruction prefix prepended automatically — stored embeddings are unaffected, no reindex required.

  **Blob persistence policy:** `blobs.max_size_bytes` (default `25 MB`, nullable to disable) and `blobs.skip_mime_types` (default `["video/*", "audio/*"]`, prefix-glob) control whether the original ingested bytes are persisted alongside the metadata row. Rows that fail either rule still get a `blobs` row with `sha256`, `mime_type`, `size_bytes`, and downloader provenance — only the `bytes` column is left NULL. Refresh, dedupe, conversion-at-ingest-time, chunks, and embeddings all keep working; only `membot read --bytes` and future re-conversion against an improved converter need the persisted bytes. To strip bytes retroactively under the current policy (e.g. after lowering the limit), run `membot prune --strip-blob-bytes --no-dry-run`.

  Values are written with file mode `0600`. `ANTHROPIC_API_KEY` set in the environment still wins on read, so existing env-var setups keep working.
- **API keys:** stored under `downloaders.<service>.api_key` in `~/.membot/config.json`. Read by API-based downloaders (GitHub, Linear).
- **Environment variables:**
  - `ANTHROPIC_API_KEY` — optional. Enables LLM fallback for messy / scanned input (vision captions for images, last-resort markdown conversion). Without it, the pipeline degrades to deterministic native conversion. Equivalent to `membot config set llm.anthropic_api_key ...`; the env var takes precedence on read.
  - `MEMBOT_HOME` — override the data directory.
  - `MEMBOT_SKIP_E2E` — skip live-network E2E downloader tests in `bun test`.
  - `NO_COLOR`, `CI`, `FORCE_COLOR` — standard output controls.

## Development

```bash
bun install
bun run dev <args>       # run from source
bun test                 # full test suite (real ephemeral DuckDB per test)
bun run lint             # biome + tsc
bun run format           # biome --write
bun run build            # compile a standalone binary into dist/membot
```

Architecture, design constraints, and reference projects are documented in [`docs/plan.md`](./docs/plan.md) and [`CLAUDE.md`](./CLAUDE.md).

## License

MIT © Evan Tahler
