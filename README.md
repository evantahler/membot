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
bunx playwright install chromium    # one-time browser binary download (~150 MB)
```

This pulls in DuckDB's per-platform native bindings and Playwright's Chromium binary alongside membot. The build externalizes `@duckdb/*` (those `.node` bindings can't be embedded by `bun build --compile`) and `playwright*` (the browser binary lives in `~/.cache/ms-playwright`), so a global Bun install is the supported path.

After installing, set up the services you want to ingest from:

```bash
membot login
```

A real Chromium window opens with two sections:

- **Browser sign-in** — Google Docs / Sheets / Slides. Click the Google link in the window, sign in, close the window. Cookies + IndexedDB persist to `~/.membot/auth/browser-profile/` and reused by every browser-based downloader.
- **API-key services** — GitHub and Linear. The window shows the settings URL where you create a token and the `membot config set …` command to run in your terminal:

```bash
# GitHub: settings/tokens → fine-grained, repo:read
membot config set downloaders.github.api_key <PAT>
# or read from environment
export GITHUB_TOKEN=<PAT>

# Linear: linear.app/settings/api → personal API key
membot config set downloaders.linear.api_key <KEY>
```

Public GitHub repos work without a token (rate-limited at 60 req/hr). Linear always needs a key.

## Quick start

```bash
membot login                                     # one-time: sign into Google / GitHub / Linear in a browser
membot add ./docs                                # ingest a directory recursively
membot add https://docs.google.com/document/d/.. # Google Docs / Sheets / Slides via export endpoints
membot add https://github.com/o/r/issues/123     # GitHub issues + PRs (with comments)
membot add https://linear.app/w/issue/ABC-12     # Linear issues + projects
membot add https://example.com/spec.pdf          # any other URL (browser print-to-PDF fallback)
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
| `membot add <sources...>`       | Ingest one or more files, directories, globs, URLs, or `inline:<text>`. Default `logical_path` mirrors the source (absolute path for local files, `remotes/{host}/{path}` for URLs) so files with the same basename in different projects don't collide. Pass `-p <path>` to override or set a prefix. Skips unchanged source bytes; pass `--force` to re-ingest. |
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
| `membot prune --before <ts>`    | Permanently drop non-current versions older than cutoff (irreversible)            |
| `membot serve`                  | Run the MCP server (stdio default; `--http <port>` for HTTP)                      |
| `membot reindex`                | Rebuild the FTS keyword index over current chunks                                 |
| `membot config <subcommand>`    | Get / set values in `~/.membot/config.json` (`get`, `set`, `unset`, `list`, `path`) |
| `membot login`                  | Open a Chromium window to sign into Google / GitHub / Linear / etc. — closes save the session |
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
  - `~/.membot/logs/` — daemon logs when running `serve --watch`.
- **Config file:** `~/.membot/config.json` (optional; defaults are sane). Edit it directly or via `membot config`:

  ```bash
  membot config list                                            # show every value (secrets masked)
  membot config set llm.anthropic_api_key sk-ant-...            # enable LLM-fallback paths
  membot config set chunker.target_chars 800                    # tweak any nested value
  membot config set embedding.workers 4                         # cap parallel embed workers
  membot config set search.semantic_weight 0.6                  # tilt hybrid-search RRF toward semantic (default 0.6; 0.5 = equal, 0 = keyword-only, 1 = semantic-only)
  membot config set converters.max_inline_image_captions 50     # raise per-doc cap on vision captions for embedded images
  membot config set ingest.worker_concurrency 4                 # cap parallel ingest workers (default: cpus-1, max 8)
  membot config set llm.describer_skip_when_titled false        # always LLM-describe (default true skips when markdown has a clear H1)
  membot config get llm.anthropic_api_key --show-secrets        # reveal the masked key
  membot config unset chunker.target_chars                      # back to schema default
  membot config path                                            # print the absolute config path
  ```

  **Parallel embedding:** `embedding.workers` (default `null` → `cpus()-1`) controls how many subprocess workers fan out the WASM embedding work. The pool is **per-command** — spawned at the start of `add` / `refresh` / `write` and killed before the command returns, so membot doesn't keep idle workers around between invocations. Each worker loads its own ~50MB copy of the model, so on RAM-constrained machines drop it to a small fixed number (e.g. `4`); set `1` to disable the pool entirely and embed inline.

  **Hybrid-search ranking:** `search.semantic_weight` (default `0.6`, range `[0, 1]`) controls reciprocal-rank fusion between the semantic and keyword sides. The semantic list contributes weight `semantic_weight`; keyword contributes `1 - semantic_weight`. The default tilts slightly toward semantic so a chunk that matches a query conceptually (without literal token overlap) can outrank docs that incidentally contain a query word. Set to `0.5` to restore equal weighting, `0.0` for keyword-only ranking behaviour, or `1.0` for semantic-only. Search-time queries also get the BGE-v1.5 instruction prefix prepended automatically — stored embeddings are unaffected, no reindex required.

  Values are written with file mode `0600`. `ANTHROPIC_API_KEY` set in the environment still wins on read, so existing env-var setups keep working.
- **Browser session:** `~/.membot/auth/browser-profile/` (Playwright persistent profile — cookies, localStorage, IndexedDB). Captured by `membot login`; cookie-based downloaders (Google) reuse it on every fetch. Delete the directory to force a fresh login.
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
