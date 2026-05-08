# membot

> Versioned context store with hybrid search for AI agents. Stdio + HTTP MCP server and CLI.

[![npm](https://img.shields.io/npm/v/membot.svg)](https://www.npmjs.com/package/membot)
[![license](https://img.shields.io/npm/l/membot.svg)](./LICENSE)

`membot` is a single-binary CLI and MCP server that gives AI agents a persistent, versioned, searchable context store. Files (markdown, PDFs, DOCX, HTML, URLs, agent-authored notes) are ingested, converted to markdown, chunked, embedded **locally** with `@huggingface/transformers` (WASM, no cloud calls), and indexed in DuckDB with hybrid search (semantic vector + BM25). Every change creates a new version — nothing is overwritten in place.

- **Local everything** — embeddings run on your machine; data lives in `~/.membot/index.duckdb`.
- **One mental model** — every artifact (markdown, PDF, image, audio) becomes a markdown surrogate that flows through the same chunk → embed → search pipeline.
- **Append-only versioning** — every ingest, refresh, or write creates a new `(logical_path, version_id)` row. History is queryable; nothing is mutated.
- **Two surfaces, one source of truth** — every operation is exposed identically as a CLI subcommand and an MCP tool. The agent sees `membot_search`; you see `membot search`.

## Install

```bash
bun install -g membot
# or
npm install -g membot
```

This pulls in DuckDB's per-platform native bindings alongside membot. The build externalizes `@duckdb/*` (those `.node` bindings can't be embedded by `bun build --compile`), so a global npm/bun install is the supported path.

## Quick start

```bash
membot add ./docs                        # ingest a directory recursively
membot add https://example.com/spec.pdf  # ingest a URL (auto-converted to markdown)
membot ls                                # list current files
membot search "how does refresh work?"   # hybrid search
membot read docs/refresh.md              # read the markdown surrogate
membot serve                             # expose the same operations as MCP tools (stdio)
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
| `membot add <source>`           | Ingest a file, directory, glob, URL, or `inline:<text>`. Default `logical_path` mirrors the source (absolute path for local files, `remotes/{host}/{path}` for URLs) so files with the same basename in different projects don't collide. Pass `-p <path>` to override or, on a directory walk, to set a prefix. Skips on unchanged source bytes; pass `--force` to re-ingest. |
| `membot ls [prefix]`            | List current files (size, mime, refresh status)                                   |
| `membot tree [prefix]`          | Render the synthesised logical-path tree                                          |
| `membot read <path>`            | Read the markdown surrogate (or `--bytes` for original bytes, base64)             |
| `membot search <query>`         | Hybrid search (semantic + BM25); `--include-history` searches older versions      |
| `membot info <path>`            | Inspect metadata (source, fetcher, schedule, digests) without content             |
| `membot versions <path>`        | List every version newest-first                                                   |
| `membot diff <path> <a> [b]`    | Unified diff between two versions                                                 |
| `membot write <path>`           | Write inline agent-authored markdown as a new version                             |
| `membot mv <from> <to>`         | Rename a logical_path (history preserved under both)                              |
| `membot rm <path>`              | Tombstone a logical_path (history still queryable)                                |
| `membot refresh [path]`         | Re-read source; new version only if bytes changed                                 |
| `membot prune --before <ts>`    | Permanently drop non-current versions older than cutoff (irreversible)            |
| `membot serve`                  | Run the MCP server (stdio default; `--http <port>` for HTTP)                      |
| `membot reindex`                | Rebuild the FTS keyword index over current chunks                                 |
| `membot mcpx <subcommand>`      | Forward to the bundled `mcpx` CLI for managing remote MCP servers                 |
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

## Configuration

- **Data directory:** `~/.membot/` (override with `MEMBOT_HOME=/path` or `--config <path>`).
  - `~/.membot/index.duckdb` — all content, blobs, chunks, embeddings, and metadata.
  - `~/.membot/models/` — cached embedding model weights (`Xenova/bge-small-en-v1.5`, 384-dim).
  - `~/.membot/logs/` — daemon logs when running `serve --watch`.
- **Config file:** `~/.membot/config.json` (optional; defaults are sane).
- **Environment variables:**
  - `ANTHROPIC_API_KEY` — optional. Enables LLM fallback for messy / scanned input (vision captions for images, last-resort markdown conversion). Without it, the pipeline degrades to deterministic native conversion.
  - `MEMBOT_HOME` — override the data directory.
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
