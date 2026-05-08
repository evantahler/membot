# `membot` — Standalone AI-Agent Context Store

## Context

`membot` is a new standalone Bun project — npm package `membot`, CLI binary `membot` — that extracts and reshapes the context system currently embedded in `botholomew` (paths under `botholomew/src/context/`, `src/tools/`, `src/db/`). Distribution and CLI shape mirror `mcpx`.

Goals (from user):

- Files are **stored only in the database** — not on disk as a tree of `.md` files. Logical paths are virtual.
- Hybrid search (vector + BM25) over chunked content.
- Tree exploration synthesised from logical paths.
- `membot add <source>` works for local paths AND remote URLs, with **mcpx-driven mini-agents** fetching remote content (Firecrawl, Google Docs, GitHub, raw HTTP). The exact mcpx invocation (server + tool + args) is stored on the row so refresh can re-invoke it directly — no agent/routing re-run.
- Everything is converted to **markdown**: PDF, DOCX, HTML, plain-text, etc. **Native libs first, LLM fallback** for messy/scanned content.
- Each row tracks `source_path`, `source_sha256`, `refreshed_at`, `refresh_frequency_sec`. `membot refresh <path>` re-reads the original source, re-hashes, and re-converts/re-embeds only if the SHA changed. Local files compared by content hash; remote URLs re-fetched via the same fetcher.
- Both **on-demand** (`membot refresh`) and **daemon** (`membot serve --watch`) refresh modes.
- Bun-compiled standalone executables (darwin/linux/windows × arm64/x64), like mcpx.
- Stdio + HTTP MCP server exposing read/write/add/search/tree/refresh tools.
- System-wide config + data dir at `~/.membot/` (override via `--config` or `MEMBOT_HOME`).
- **Embeddings are LOCAL only** — `@huggingface/transformers` WASM with `Xenova/bge-small-en-v1.5` (384-dim). No cloud embedding APIs. (See memory: `feedback_local_embeddings_only.md`.)

---

## Architecture Snapshot

```
~/.membot/
  config.json           # user config
  index.duckdb          # all content, chunks, embeddings, FTS
  models/               # cached @huggingface/transformers WASM weights
  logs/                 # daemon logs (when --watch)
```

DuckDB is the only persistent store. There is **no** `~/.membot/context/` filesystem tree — the agent's "files" are rows.

---

## Presentation & Errors

### Two presentation modes

The CLI auto-detects its environment and renders appropriately. There is **one** code path for output — the logger and formatter inspect the environment once at startup and degrade gracefully.

| Condition                                                | Mode             | Behavior                                                                                       |
| -------------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------- |
| stdout is a TTY AND stderr is a TTY AND `--json` not set | **interactive**  | ANSI colors, `nanospinner` spinners during work, progress bars for multi-entry ops, aligned tables |
| stdout is piped, redirected, or `--json` is set          | **non-interactive** | No spinners, no progress bars, no colors. JSON to stdout, structured logs to stderr. Stable, parseable. |
| `CI=true` env var set                                    | non-interactive (forced) + **silent** | Same as above; never accidentally emit ANSI/spinners in CI logs. Advisory `info` and per-entry progress lines suppressed. |
| `NODE_ENV=test` (set automatically by `bun test`) or `MEMBOT_SILENT=1` | **silent** | `info` and per-entry progress are no-ops. `warn` and `error` still print. `--verbose` overrides. |
| `--no-color` flag or `NO_COLOR` env var                  | non-interactive (colors only) | Spinners stay if TTY, but no ANSI color codes (FORCE_COLOR overrides)                       |

Implementation lives in `src/output/`:

- `tty.ts` — single source of truth for `isInteractive()`, `useColor()`, `useSpinner()`, `isSilent()`. Reads `process.stdout.isTTY`, `process.stderr.isTTY`, `process.env.CI`, `NO_COLOR`, `FORCE_COLOR`, `NODE_ENV`, `MEMBOT_SILENT`, and the `--json` / `--verbose` / `--no-interactive` flags.
- `logger.ts` — spinner-aware (port from `mcpx/src/output/logger.ts`); `info/warn/error/debug/writeRaw` route to stderr in non-interactive mode and don't break parseable stdout.
- `progress.ts` — wraps `nanospinner` + a multi-entry progress bar (used by directory/glob ingest); in non-interactive mode emits one `info` line per entry instead.
- `formatter.ts` — final-result rendering: aligned tables / markdown when interactive, single JSON object when not.

The mount adapter in `src/mount/commander.ts` is responsible for opening a spinner before the handler runs and closing it (success or failure) after — operations themselves call `ctx.progress.tick()` to update progress, but they never know whether they're being rendered interactively. The same handler runs unchanged when invoked via MCP.

### `HelpfulError` — the only error class

**Rule:** every error raised inside the application must be (or be wrapped into) a `HelpfulError`. A bare `throw new Error(...)` is a bug. The mount adapters (`mountAsCommanderCommand`, `mountAsMcpTool`) refuse to render anything else — they catch unknown errors and convert them, but linting / tests should fail when a non-`HelpfulError` reaches the surface.

```ts
// src/errors.ts
export type ErrorKind =
  | 'input_error'        // bad input from the user/LLM — not retryable as-is
  | 'not_found'          // requested resource doesn't exist
  | 'conflict'           // path/version already exists where it shouldn't
  | 'auth_error'         // upstream auth failed (mcpx fetcher, anthropic key, etc.)
  | 'network_error'      // transient network failure — retryable
  | 'unsupported_mime'   // converter doesn't know how to handle this type
  | 'partial_failure'    // multi-entry op (dir/glob ingest) had per-entry failures
  | 'internal_error';    // bug — should never reach the user

export class HelpfulError extends Error {
  readonly kind: ErrorKind;
  readonly hint: string;             // REQUIRED. The actionable next step. Shown to humans AND LLMs.
  readonly details?: unknown;        // optional structured payload (per-entry failures, etc.)
  readonly cause?: unknown;          // original error if wrapped

  constructor(args: {
    kind: ErrorKind;
    message: string;
    hint: string;                    // ← non-optional by type
    details?: unknown;
    cause?: unknown;
  }) {
    super(args.message);
    if (!args.hint || !args.hint.trim()) {
      throw new Error('HelpfulError requires a non-empty hint');
    }
    this.name = 'HelpfulError';
    this.kind = args.kind;
    this.hint = args.hint;
    this.details = args.details;
    this.cause = args.cause;
  }
}

// Helper: wrap an unknown error so callers can `try { ... } catch (e) { throw asHelpful(e, 'while reading PDF', 'Try re-running with --force, or check that the file is readable.') }`
export function asHelpful(
  cause: unknown,
  context: string,
  hint: string,
  kind: ErrorKind = 'internal_error',
): HelpfulError;
```

The constructor's `hint` parameter is statically required (object-arg pattern) AND validated at runtime — there is no path to construct a hint-less error. PRs that catch a `HelpfulError` and re-throw with a less specific hint should be rejected in review.

#### Hint quality bar

A good hint names the next action concretely. Examples:

| Bad hint                                  | Good hint                                                                                       |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `"Check your config."`                    | `"Run \`membot config show\` to see the active config, or set ANTHROPIC_API_KEY to enable LLM fallback."` |
| `"File not found."`                       | `"No file at logical_path 'docs/auth.md'. Run \`membot ls docs/\` to see what's there."`           |
| `"Auth failed."`                          | `"mcpx returned 401 from server 'firecrawl'. Run \`mcpx auth firecrawl\` and retry."`           |
| `"Glob matched no files."`                | `"Glob './*.md' matched 0 files. Try a broader pattern (e.g. './**/*.md') or relax --exclude."`  |
| `"Unsupported file type: image/heic."`    | `"image/heic isn't supported by the native pipeline. Convert to PNG/JPEG first, or pass --force-llm to use the vision fallback."` |

#### Rendering

`mountAsCommanderCommand` wraps every handler. On `HelpfulError`:

```
Interactive (TTY):
  ✗ membot add: <message in red>
    hint: <hint in dim/yellow>
    [details: pretty-printed when present]
  exit code = mapKindToExit(kind)   // input_error=2, not_found=3, conflict=4, auth_error=5, network_error=6, unsupported_mime=7, partial_failure=8, internal_error=1

Non-interactive (--json or piped):
  stdout: <empty or partial result up to the point of failure>
  stderr: {"ok": false, "error": {"kind": "...", "message": "...", "hint": "...", "details": ...}}\n
  exit code = same as above
```

`mountAsMcpTool` wraps every handler. On `HelpfulError`:

```
MCP tool result (returned, not thrown):
  isError: true
  content: [{ type: "text", text: "<message>\n\nhint: <hint>" }]
  structuredContent: { error: { kind, message, hint, details? } }
```

The `hint` always lands in front of both the human reading the terminal and the LLM consuming the MCP response — verbatim, same string. No translation layer.

### Logging vs. errors

- **Logger lines** (info/warn/debug) go to stderr and are advisory. They never become errors.
- **Errors** are thrown, caught at the mount boundary, rendered once. Operations should never log-and-rethrow — that double-renders.
- **Spinners** describe the *current* operation; the spinner's failure path on a thrown `HelpfulError` is to fail with the error's `message` as the failed-state label, then the renderer prints the hint underneath.

---

## Database Schema (DuckDB)

`src/db/migrations/001-init.sql`:

### Versioning model

`files` is **append-only**. Every successful ingest or content-changing refresh inserts a new row for that `logical_path` with a fresh `version_id` (a millisecond TIMESTAMP). The "current" version of a path is `MAX(version_id)` for that path that is not tombstoned. All MCP tools default to operating on the current version; every read-shaped tool accepts an optional `version` parameter to address an older snapshot.

- Deletes are tombstones — they insert a new row with `tombstone=TRUE` and `content=''` rather than removing data.
- `chunks` are scoped to `(logical_path, version_id)` so historical search would be possible later. By default the FTS + semantic queries filter to current versions only via the `current_files` view.

```sql
-- Content-addressed binary store. Originals of every ingested artifact live
-- here, deduped by sha256. Many `files` rows can share one blob.
CREATE TABLE blobs (
  sha256     TEXT PRIMARY KEY,
  mime_type  TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  bytes      BLOB NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE files (
  logical_path    TEXT NOT NULL,               -- "docs/api/auth.md" — what agents see
  version_id      TIMESTAMP NOT NULL DEFAULT now(),  -- doubles as version label; ms precision
  tombstone       BOOLEAN NOT NULL DEFAULT FALSE,
  source_type     TEXT NOT NULL,               -- 'local' | 'remote' | 'inline'
  source_path     TEXT,                        -- abs filesystem path or URL (NULL for inline writes)
  source_mtime_ms BIGINT,                      -- last seen mtime (local files only)
  source_sha256   TEXT,                        -- sha256 of original raw bytes (NULL on tombstone). Equals blob_sha256 for non-inline rows.
  blob_sha256     TEXT REFERENCES blobs(sha256), -- pointer to the original bytes (NULL when source_type='inline' or tombstoned)
  content_sha256  TEXT,                        -- sha256 of converted markdown surrogate
  content         TEXT,                        -- converted markdown surrogate
  description     TEXT,                        -- ALWAYS-PRESENT one-paragraph summary (LLM-generated; covers text and binary alike). Prepended to every chunk's embedded text.
  mime_type       TEXT,
  size_bytes      BIGINT,
  fetcher         TEXT,                        -- 'http' | 'mcpx' | 'local' | 'inline'
  fetcher_server  TEXT,                        -- mcpx server name (e.g. 'firecrawl', 'google-docs', 'github') — NULL unless fetcher='mcpx'
  fetcher_tool    TEXT,                        -- mcpx tool name (e.g. 'scrape', 'get_doc') — NULL unless fetcher='mcpx'
  fetcher_args    JSON,                        -- full args object passed to the mcpx tool — replayable as-is on refresh
  refresh_frequency_sec INTEGER,               -- NULL = never auto-refresh
  refreshed_at    TIMESTAMP,
  last_refresh_status TEXT,                    -- 'ok' | 'unchanged' | 'failed:<reason>'
  change_note     TEXT,                        -- optional human/agent annotation: "manual edit", "refresh: source updated", etc.
  created_at      TIMESTAMP NOT NULL DEFAULT now(),
  PRIMARY KEY (logical_path, version_id)
);

-- Latest non-tombstoned version per logical_path. All MCP/CLI defaults filter through this view.
CREATE VIEW current_files AS
  SELECT f.* FROM files f
  WHERE (f.logical_path, f.version_id) IN (
    SELECT logical_path, MAX(version_id) FROM files GROUP BY logical_path
  )
    AND f.tombstone = FALSE;

CREATE TABLE chunks (
  logical_path   TEXT NOT NULL,
  version_id     TIMESTAMP NOT NULL,
  chunk_index    INTEGER NOT NULL,
  chunk_content  TEXT NOT NULL,                -- raw markdown segment (what membot_read returns when slicing)
  search_text    TEXT NOT NULL,                -- "<logical_path>\n<description>\n\n<chunk_content>" — the exact string that was embedded and is FTS-indexed
  embedding      FLOAT[384] NOT NULL,          -- vector of search_text
  PRIMARY KEY (logical_path, version_id, chunk_index),
  FOREIGN KEY (logical_path, version_id) REFERENCES files(logical_path, version_id)
);

-- Chunks belonging to current versions only. Search joins through this.
CREATE VIEW current_chunks AS
  SELECT c.* FROM chunks c
  JOIN current_files cf USING (logical_path, version_id);
```

`src/db/migrations/002-fts.sql`: `PRAGMA create_fts_index('current_chunks', 'rowid', 'search_text', stemmer='porter')` — indexes the prepended search_text (filename + description + chunk content) so keyword hits surface even when the matching term is in the path or description, not the body. Rebuilt by `membot reindex` whenever versions are added/tombstoned.

Tree exploration is `SELECT logical_path FROM current_files`, grouped client-side by `/` prefix (synthesised — there are no real directories).

### Pruning history

Versions accumulate forever by default. `membot prune --before <duration>` and the matching `membot_prune` MCP tool drop non-current versions older than the cutoff. Tombstones are kept until at least one newer version exists, so reachability stays simple. `membot prune` also garbage-collects orphan rows in `blobs` (sha256 not referenced by any remaining `files` row).

### Binary content & the textual-surrogate rule

Some sources don't have a useful textual form: images, audio, video, executables, fonts, etc. The store handles these uniformly with one rule:

> **Every ingested artifact produces a markdown surrogate.** The surrogate flows through chunking, embedding, and FTS like any other markdown. The original bytes are kept in the `blobs` table and addressed via `files.blob_sha256` for agents that can consume the native form.

This means the search/embed pipeline has zero special cases for binary content — the surrogate IS the content as far as retrieval is concerned. Concretely:

| Source type            | Surrogate (`files.content`)                                            | Blob kept? |
| ---------------------- | ---------------------------------------------------------------------- | ---------- |
| markdown / text        | passthrough                                                            | yes        |
| HTML                   | turndown output                                                        | yes        |
| PDF (text layer)       | unpdf extraction                                                       | yes        |
| PDF (scanned, no text) | Tesseract WASM OCR → markdown                                          | yes        |
| DOCX                   | mammoth output                                                         | yes        |
| image (PNG/JPEG/etc.)  | Claude vision caption + Tesseract WASM OCR for any embedded text       | yes        |
| audio                  | (deferred — surrogate would be a transcript when we add Whisper WASM)  | yes        |
| anything else          | LLM caption from a base64 sample, or `"(unknown binary)"` if no key    | yes        |

The `blob_sha256` foreign key gives content-addressed dedupe automatically — re-ingesting the same image under a different logical_path stores zero new bytes.

### Always-on description (`files.description`)

Every file gets an LLM-written one-paragraph description, regardless of type — including plain markdown. The description column is **prepended to every chunk's embedded text** (along with the logical path), so:

- Searches like `"the OAuth diagram"` hit a PNG even though the chunk body is empty markdown.
- Searches like `"meeting notes from last quarter's planning"` hit a markdown file whose body never says that phrase.
- Filename signals ("auth.md", "diagrams/oauth-flow.png") are part of the embedded text, lifting recall without hurting precision because the text-prefix is short and consistent.

The exact embedded string per chunk is:

```
<logical_path>
<description>

<chunk_content>
```

…stored verbatim as `chunks.search_text`. FTS is built on `search_text`, the embedding is the vector of `search_text`. Keeping `chunk_content` as a separate column means `membot_read` and the `snippet` field on search hits return the clean body without the prefix bleed-through.

When `ANTHROPIC_API_KEY` is missing, `description` falls back to a deterministic heuristic (e.g. first heading + first 200 chars for markdown; `"<mime_type> · <size>"` for binaries) so the pipeline still works offline — just with weaker recall.

### Tesseract WASM (OCR)

OCR runs as part of the converter dispatch, only on filetypes where it's likely useful:

- All `image/*` types: PNG, JPEG, WebP, BMP, TIFF.
- PDFs whose unpdf extraction returned an empty / very-low-text-ratio result (likely scanned).

OCR output is folded into the same surrogate that the LLM caption produces — one chunked markdown body per file, with a fenced section `## Text detected via OCR` when OCR ran. No separate row, no separate index.

---

## Operations: one definition, two surfaces

Each user-facing capability is defined ONCE as an **Operation** and mounted twice — as an MCP tool and as a commander CLI command. The zod input schema, output schema, description string, and handler are all single-source-of-truth. Adding a new operation means writing one file in `src/operations/` and exporting it from the registry; both the CLI and the MCP server pick it up automatically.

### `Operation<I, O>` shape (`src/operations/types.ts`)

```ts
export interface Operation<I extends z.ZodObject, O extends z.ZodTypeAny> {
  // Tool name as agents see it (also used for the MCP tool registration).
  name: string;                                 // e.g. "membot_add"

  // CLI subcommand name. Defaults to name with "membot_" stripped and "_" → "-".
  cliName?: string;                             // e.g. "add"

  // Verbatim description string. Used as BOTH the MCP tool description
  // and the commander .description() text. Follows the bash-prefix →
  // purpose → when-to-use → recovery-hint shape (see §MCP Tool Surface).
  description: string;

  // Single source of truth for the input contract.
  inputSchema: I;
  outputSchema: O;

  // CLI-only metadata: which input fields are positional CLI args, and
  // any short-flag aliases. Fields not listed in `positional` become
  // `--flags`; booleans become `--flag` / `--no-flag`; defaults from
  // .default() in the schema are honored.
  cli?: {
    positional?: (keyof z.infer<I>)[];
    aliases?: Partial<Record<keyof z.infer<I>, string>>;  // e.g. logical_path: "-p"
    stdinField?: keyof z.infer<I>;              // read this field from stdin if not provided
  };

  // The work itself. AppContext gives access to db, embedder, mcpx, logger, config.
  handler: (input: z.infer<I>, ctx: AppContext) => Promise<z.infer<O>>;
}
```

Field-level help comes from `.describe()` on the zod schema — used as both the MCP parameter description and the commander option description. Example:

```ts
inputSchema: z.object({
  source: z.string().describe('Local path, URL, or `inline:<text>` literal'),
  logical_path: z.string().optional().describe('Logical path under the store (defaults derived from source)'),
  refresh_frequency: z.string().optional().describe('Refresh cadence: 5m | 1h | 24h | 7d. Omit for no auto-refresh.'),
  fetcher_hint: z.enum(['firecrawl','github','gdocs','http']).optional().describe('Force a specific mcpx fetcher'),
}),
cli: {
  positional: ['source'],
  aliases: { logical_path: '-p', refresh_frequency: '-r' },
}
```

### Mount adapters

`src/mount/mcp.ts` — `mountAsMcpTool(server, op)`:
- Registers the tool with `op.name` and `op.description`.
- Converts `op.inputSchema` to JSON-Schema (via `zod-to-json-schema`) for the MCP `inputSchema` field.
- Wraps `op.handler` with input validation (`op.inputSchema.parse`) + output validation (`op.outputSchema.parse`) + error normalization (`{error_kind, message, next_action_hint}`).

`src/mount/commander.ts` — `mountAsCommanderCommand(program, op)`:
- Adds a subcommand named `op.cliName ?? op.name.replace(/^membot_/, '').replaceAll('_','-')`.
- Sets `.description(op.description)`. The same string the LLM sees is what `membot --help` shows.
- Walks `op.inputSchema.shape`. For each field:
  - If listed in `op.cli.positional` → `.argument(required ? '<name>' : '[name]', describe)`.
  - Else if `ZodBoolean` → `.option('--flag-name [<bool>]', describe)`, with `--no-flag-name` synthesised.
  - Else → `.option('--flag-name <value>', describe, defaultValue?)`. Short alias prepended if `op.cli.aliases[field]` is set.
  - `ZodEnum` → option with `.choices(...)`.
  - `ZodArray` of strings → repeatable `.option('--tag <value>', ..., collect)`.
- On invocation, builds a single object from positional args + options, runs `op.inputSchema.parse(...)`, calls `op.handler`, and renders the result via `output/formatter.ts` (JSON if `--json`, otherwise human-readable per output schema).

Result: the description an agent reads in `tools/list` is byte-identical to what a human reads in `membot <cmd> --help`. Drift is impossible by construction.

### Operation registry (`src/operations/index.ts`)

A single array of operations exported in the order they should appear in `--help`. `cli.ts` and `mcp/server.ts` both iterate this list and call the appropriate mount adapter. Adding a new tool means: write one file, append it here, done.

---

## Project Layout (mirrors mcpx)

```
membot/
  src/
    cli.ts                   # commander entry; loops operations + mountAsCommanderCommand. Plus a couple of CLI-only commands (serve, reindex).
    sdk.ts                   # exported API for embedding membot in other apps
    context.ts               # AppContext (config, db, embedder, mcpx client, logger)
    constants.ts             # MEMBOT_HOME, DEFAULTS, EMBEDDING_DIMENSION=384
    operations/              # ★ single source of truth for every tool/command
      types.ts               # Operation<I,O>, defineOperation()
      index.ts               # ordered registry of all operations
      add.ts list.ts tree.ts read.ts write.ts search.ts remove.ts
      move.ts refresh.ts info.ts versions.ts diff.ts prune.ts
    mount/
      mcp.ts                 # mountAsMcpTool: zod → JSON-Schema, validate I/O, catch HelpfulError → MCP isError result with hint surfaced in both content[].text and structuredContent.error
      commander.ts           # mountAsCommanderCommand: zod → .argument()/.option(), parse → validate → spinner.start → handler → spinner.success/fail → format. Catches HelpfulError, renders message+hint+exit-code; wraps unknown throws via asHelpful()
      zod-to-cli.ts          # the field-walking logic; covers ZodString/Number/Boolean/Enum/Array/Optional/Default
    commands/                # CLI-only commands that don't have an MCP equivalent
      serve.ts               # membot serve [--http <port>] [--watch]
      reindex.ts             # membot reindex
    config/
      loader.ts              # reads ~/.membot/config.json + env overrides
      schemas.ts             # CtxConfig zod schema
    db/
      connection.ts          # DuckDB pool, migration runner
      migrations/            # 001-init.sql, 002-fts.sql
      files.ts               # files-table CRUD: insertVersion, getCurrent, getVersion, listVersions, tombstone, prune
      chunks.ts              # chunks CRUD + searchSemantic + searchKeyword (against current_chunks view by default)
      blobs.ts               # blobs-table CRUD: upsertBySha (no-op on existing sha), readBlob, gcOrphans
      views.sql              # current_files, current_chunks views
    ingest/
      source-resolver.ts     # expands a source arg: file | dir-walk (symlinks followed, realpath dedupe) | glob (picomatch) | URL | inline:; honors include/exclude
      fetcher.ts             # PORT from botholomew/src/context/fetcher.ts — mcpx-driven; returns {bytes, mime, fetcher, fetcher_server, fetcher_tool, fetcher_args} so the chosen invocation can be persisted and replayed on refresh
      local-reader.ts        # read+hash local file, detect mtime change
      converter/
        index.ts             # dispatch by mime
        pdf.ts               # unpdf (Bun-friendly PDF text extract); falls through to ocr.ts when extraction is empty/low-ratio
        docx.ts              # mammoth
        html.ts              # turndown
        image.ts             # Claude vision caption + OCR fold-in
        text.ts              # passthrough
        ocr.ts               # Tesseract WASM (tesseract.js) — used by image.ts and pdf.ts fallback
        llm.ts               # Claude markdown fallback (PORT botholomew/src/context/markdown-converter.ts)
      describer.ts           # always-on one-paragraph LLM description (with deterministic offline fallback)
      chunker.ts             # PORT botholomew/src/context/chunker.ts (deterministic + LLM modes)
      embedder.ts            # PORT botholomew/src/context/embedder-impl.ts (WASM transformers); embeds the prepended search_text
      search-text.ts         # buildSearchText(logical_path, description, chunk_content) — single source of truth for the embedded/FTS string
      ingest.ts              # orchestrator: resolve → for each entry: read → blob.upsert → convert → describe → chunk → embed → insert version
    search/
      hybrid.ts              # PORT botholomew/src/tools/search/fuse.ts (RRF)
      semantic.ts            # cosine via DuckDB array_cosine_distance
      keyword.ts             # BM25 via DuckDB FTS match_bm25()
    refresh/
      runner.ts              # refreshFile(id|path) — core logic
      scheduler.ts           # daemon tick loop for --watch
    mcp/
      server.ts              # @modelcontextprotocol/sdk: stdio + streamable-http; loops operations + mountAsMcpTool
      instructions.ts        # server-level `instructions` string (see plan §MCP)
    output/
      tty.ts                 # isInteractive() / useColor() / useSpinner() — single source for TTY/CI/--json/NO_COLOR detection
      logger.ts              # spinner-aware (port from mcpx/src/output/logger.ts); routes to stderr in non-interactive mode
      progress.ts            # nanospinner wrapper + multi-entry progress bar (used by dir/glob ingest); degrades to one info-line-per-entry when non-interactive
      formatter.ts           # final-result rendering: aligned tables/markdown when interactive, JSON when not
    errors.ts                # HelpfulError class + asHelpful() wrapper + ErrorKind union + mapKindToExit()
  scripts/
    apply-patches.sh              # @huggingface/transformers (verbatim from mcpx) + @evantahler/mcpx onnx-wasm-paths stub
  test/
    _preload.ts                   # transformers patch hook
    ingest/   db/   search/   refresh/   mcp/
  patches/                        # @huggingface/transformers patch (copy from mcpx)
  install.sh   install.ps1        # copy+adapt from mcpx
  package.json  tsconfig.json  biome.json  bunfig.toml
  README.md  CLAUDE.md
```

---

## Critical Files to Port

Direct ports (light edits — drop Botholomew-specific deps, swap `projectDir/context/` filesystem for DuckDB rows):

| New file                           | Source                                                                  |
| ---------------------------------- | ----------------------------------------------------------------------- |
| `src/ingest/embedder.ts`           | `botholomew/src/context/embedder-impl.ts`                               |
| `src/ingest/chunker.ts`            | `botholomew/src/context/chunker.ts`                                     |
| `src/ingest/fetcher.ts`            | `botholomew/src/context/fetcher.ts` + `fetcher-errors.ts`               |
| `src/ingest/converter/llm.ts`      | `botholomew/src/context/markdown-converter.ts`                          |
| `src/search/semantic.ts`           | `botholomew/src/tools/search/semantic.ts` + `src/db/embeddings.ts`      |
| `src/search/hybrid.ts`             | `botholomew/src/tools/search/fuse.ts`                                   |
| `src/search/keyword.ts`            | `botholomew/src/tools/search/regexp.ts` (replace regex with FTS BM25)   |
| `scripts/apply-patches.sh`, `patches/`            | `mcpx/scripts/...`, `mcpx/patches/` (+ local `@evantahler/mcpx@0.21.4` stub patch) |
| `src/output/logger.ts`             | `mcpx/src/output/logger.ts`                                             |
| `src/cli.ts` skeleton              | `mcpx/src/cli.ts`                                                       |
| `install.sh`, `install.ps1`        | `mcpx/install.sh`, `mcpx/install.ps1`                                   |

New code:

- `src/db/*` — DuckDB schema/CRUD (replaces botholomew's `context/store.ts` filesystem layer).
- `src/ingest/converter/{pdf,docx,html,text}.ts` — native conversion path before LLM fallback.
- `src/ingest/local-reader.ts` — read + sha256 + mtime for local sources.
- `src/refresh/{runner,scheduler}.ts` — refresh per-row + daemon tick.
- `src/mcp/server.ts` and `src/mcp/tools/*` — MCP exposure (botholomew's tools assume FS sandboxing; we rewrite against DB).

---

## Data Flow — Ingest

```
membot add <source> [--path <logical>] [--refresh 24h] [--include <glob>] [--exclude <glob>]
  ↓
expand-source:                                          (only for local sources)
    file        → [file]
    directory   → walk(symlinks_followed=true) filtered by include/exclude globs
    glob        → picomatch over realpath()-ed entries
  ↓                                                     for each resolved entry:
local-reader.read()  OR  fetcher.fetchUrl()          ← raw bytes + mime + sha256
                                                       (fetchUrl also returns chosen mcpx server/tool/args
                                                        → persisted on the row for fast replay-on-refresh)
  ↓
blobs.upsert(sha256, bytes, mime)                    ← content-addressed, deduped
  ↓
converter/index.ts dispatch(mime):
    pdf            → unpdf.extractText() → if empty/low-ratio → ocr.tesseract()
    docx           → mammoth.convertToMarkdown()
    html           → turndown.turndown()
    image/*        → vision.describeImage() + ocr.tesseract() (folded together)
    text / md      → passthrough
    other          → llm.convertWithClaude()  (or "(unknown binary)" if no API key)
  ↓
describe(markdown_or_caption, mime, logical_path)    ← always runs; one-paragraph LLM summary
                                                       (or deterministic fallback when no API key)
  ↓
chunker.chunk(markdown)                              ← deterministic by default; LLM opt-in
  ↓
buildSearchText(logical_path, description, chunk)    ← prepended for embedding + FTS
  ↓
embedder.embedBatch(search_texts)                    ← WASM transformers, 384-dim
  ↓
db.files.insertVersion + db.chunks.insertForVersion + FTS rebuild
(every successful ingest produces a NEW version_id; nothing is overwritten;
 directory/glob ingest is one transaction per matched entry, not all-or-nothing)
```

## Data Flow — Refresh

`membot refresh <path>` (or daemon tick, or no-arg = "all due"):

1. Load `files` row.
2. If `source_type='local'`: `stat()`; if `mtime_ms == source_mtime_ms`, skip. Otherwise re-read + sha256.
3. If `source_type='remote'`:
   - If `fetcher='mcpx'`: directly invoke `mcpx exec <fetcher_server> <fetcher_tool> <fetcher_args>` — no agent re-routing.
   - If `fetcher='http'`: plain `fetch(source_path)`.
   - sha256 the resulting bytes.
4. Compare `new_source_sha256 == files.source_sha256`. If equal → set `refreshed_at=now()`, `last_refresh_status='unchanged'`, done.
5. If different → re-run convert → chunk → embed → **insert a new `files` row** with `version_id=now()`, new `content`/`source_sha256`/`content_sha256`, `change_note='refresh: source updated'`. Insert the new chunks under that version. Old version remains in history.
6. On failure (network, fetcher error, conversion error): leave existing version untouched, write `last_refresh_status='failed:<reason>'` onto the most recent row in place (status fields are mutable; content fields are not).

`membot refresh` with no arg = all rows where `refresh_frequency_sec IS NOT NULL AND now() > refreshed_at + (refresh_frequency_sec * INTERVAL '1 second')`.

Daemon (`membot serve --watch`): `setInterval(tick_interval_sec)` runs the no-arg refresh; default 60s. Same code path.

---

## CLI Surface

```
membot add <source> [--path <logical>] [--include <glob>] [--exclude <glob>] [--no-follow-symlinks] [--refresh <dur>] [--fetcher <name>]
membot ls [<prefix>] [--json]
membot tree [<prefix>] [--depth <n>]
membot read <path> [--version <ts>] [--meta]
membot write <path> [--refresh <dur>] [--note <msg>] < stdin
membot search <query> [--limit 10] [--mode hybrid|semantic|keyword]
membot info <path> [--version <ts>]
membot mv <old> <new>
membot rm <path>                                # tombstone (history kept)
membot refresh [<path>] [--force]
membot versions <path>                          # list every version_id with change_note
membot diff <path> <a-version> [<b-version>]    # markdown diff between two versions (defaults b=current)
membot prune [--before <dur>]                   # drop non-current versions older than cutoff
membot reindex
membot serve [--http <port>] [--watch] [--tick <sec>]
```

Global flags (mirror mcpx): `-c/--config`, `-j/--json`, `-F/--format`, `-v/--verbose`, `--no-interactive`.

`--refresh` and `--before` accept duration strings: `5m`, `1h`, `24h`, `7d`.
`--version` accepts an ISO-8601 timestamp or millis-since-epoch — exact match against `files.version_id`.

---

## MCP Tool Surface

Stdio (default) and streamable-HTTP, both via `@modelcontextprotocol/sdk`. Each tool is **defined as an `Operation` in `src/operations/`** and mounted via `mountAsMcpTool`. The same `Operation` is mounted as a commander subcommand by `mountAsCommanderCommand` — descriptions, schemas, and validation are identical across the two surfaces. Errors are always `HelpfulError` instances (see §Presentation & Errors); the mount adapter renders `kind`, `message`, and the required `hint` into the MCP response so the LLM gets the same actionable guidance a human would.

### Worked example: `membot_add`

```ts
// src/operations/add.ts
import { z } from 'zod';
import { defineOperation } from './types';
import { ingest } from '../ingest/ingest';

export const add = defineOperation({
  name: 'membot_add',
  cliName: 'add',
  description: `[[ bash equivalent: ingest a source ]] Ingest a new source into
the store: a local file path OR a URL OR an inline:<text> literal. URLs are
fetched via mcpx (the chosen server + tool + args are stored so refresh
replays the exact invocation). PDF/DOCX/HTML are converted to markdown —
native libs first, LLM fallback for messy/scanned input. Setting
refresh_frequency enables automatic refresh from the daemon. Always creates
a NEW version; existing versions stay queryable via membot_versions.`,
  inputSchema: z.object({
    source:            z.string().describe('Local path, URL, or `inline:<text>` literal'),
    logical_path:      z.string().optional().describe('Logical path under the store (defaults derived from source)'),
    refresh_frequency: z.string().optional().describe('Refresh cadence: 5m | 1h | 24h | 7d. Omit for no auto-refresh.'),
    fetcher_hint:      z.enum(['firecrawl','github','gdocs','http']).optional().describe('Force a specific mcpx fetcher'),
    change_note:       z.string().optional().describe('Free-text note attached to the new version'),
  }),
  outputSchema: z.object({
    logical_path:  z.string(),
    version_id:    z.string(),
    mime_type:     z.string().nullable(),
    size_bytes:    z.number(),
    fetcher:       z.string(),
    source_sha256: z.string(),
  }),
  cli: {
    positional: ['source'],
    aliases: { logical_path: '-p', refresh_frequency: '-r', change_note: '-m' },
  },
  handler: async (input, ctx) => ingest(input, ctx),
});
```

This single definition produces:

- **MCP tool** `membot_add` with the description above, JSON-Schema input derived from zod, and validated output.
- **CLI command** `membot add <source> [-p <path>] [-r <dur>] [--fetcher-hint <name>] [-m <note>]` whose `--help` text is byte-identical to the description above.

### Server-level instructions

These are sent as the MCP server's top-level `instructions` field — the LLM sees them once when the server is connected. They frame how the tool surface should be used:

```
You have a persistent context store. Files live as versioned markdown rows
addressed by logical path (e.g. "research/threat-models/llm.md"). The store
is a hybrid search index: every file is chunked, embedded locally, and
indexed with BM25 — so prefer membot_search to membot_read+grep for discovery.

Workflow:
  1. membot_tree or membot_search to find what already exists before adding new content.
  2. membot_add to ingest a local file, a URL, or a remote document. URLs are
     fetched via mcpx (Firecrawl/Google-Docs/GitHub/HTTP); the chosen
     invocation is stored so refresh is fast and deterministic.
  3. membot_read or membot_search hits to consume content.
  4. membot_write to record agent-authored notes (source_type='inline').

Versioning:
  - Every ingest, refresh, or write that changes content creates a NEW
    version_id (a timestamp). Older versions stay queryable via the
    `version` parameter on membot_read / membot_info / membot_versions / membot_diff.
  - All other tools default to the current (latest, non-tombstoned) version.
  - membot_delete is a tombstone — history is preserved unless membot_prune runs.

Refresh:
  - Each row has source metadata. membot_refresh re-reads the source, hashes
    it, and only re-embeds when bytes changed. Safe to call often.
  - If a file has refresh_frequency_sec set, the daemon refreshes it
    automatically — you do not need to schedule it yourself.

When in doubt: search before you read, read before you write, and prefer
adding the source URL once (with a refresh interval) over copy-pasting
content that will go stale.
```

### Tool catalog

Description text below is the verbatim string sent to the LLM. Style: **bash-equivalent prefix → one-line purpose → when-to-use → constraints/recovery hints**, modeled on botholomew + Arcade's tool-description pattern.

#### `membot_search`

```
[[ bash equivalent: grep -r + semantic-search ]] Hybrid search over the context
store. Pass `query` (natural language → semantic) and/or `pattern` (regex over
chunk text); pass both for the strongest signal — hits matched by both float
to the top via reciprocal rank fusion. Searches the CURRENT version of every
file by default; set `include_history=true` to also search older versions.
This is the primary discovery tool — prefer it over membot_read+scan.
```

Inputs: `query?`, `pattern?`, `mode?` (`hybrid`|`semantic`|`keyword`, default `hybrid`), `path_prefix?`, `limit?` (default 10), `include_history?` (default false), `ignore_case?`.
Output: `[{logical_path, version_id, chunk_index, snippet, score, semantic_score, keyword_score}]`.

#### `membot_tree`

```
[[ bash equivalent: tree ]] Render the logical-path tree of the current store.
Tree is synthesised from "/" segments in logical_path — there are no real
directories. Tombstoned and historical versions are hidden. Use this before
membot_add to pick a sensible logical path.
```

Inputs: `prefix?`, `max_depth?` (default 4).

#### `membot_list`

```
[[ bash equivalent: ls ]] List current files under an optional prefix, with
size, mime type, refresh frequency, and last refresh status. Returns one row
per logical_path (current version only). Pair with membot_tree for discovery,
membot_search for content-based discovery.
```

Inputs: `prefix?`, `limit?`, `cursor?` (paginated).

#### `membot_read`

```
[[ bash equivalent: cat ]] Read a stored file. By default returns the
markdown surrogate (the converted/captioned text body). Pass bytes=true
to instead return the original raw bytes (base64-encoded for JSON, or as
an image content block when the path is an image and the MCP client
supports it). Defaults to the current version; pass `version` (timestamp)
to read a historical snapshot — use membot_versions to enumerate available
versions. For finding content across many files, use membot_search instead
of repeated membot_read calls.
```

Inputs: `logical_path`, `version?`, `bytes?` (default `false`), `offset?` (line, 1-based; ignored when bytes=true), `limit?` (lines; ignored when bytes=true).
Output (text mode): `{logical_path, version_id, content, description, mime_type, size_bytes, blob_available, version_is_current}`.
Output (bytes mode): `{logical_path, version_id, mime_type, size_bytes, bytes_base64}` — or for image mimes, an MCP image content block.

#### `membot_info`

```
Inspect metadata for a file: source (local path or URL), fetcher used,
refresh schedule, last refresh status, all sha256 digests, and whether
the requested version is the current one. Does NOT return file content —
use membot_read for that. Use this to decide whether a refresh is worth
forcing or whether to trust a cached row.
```

Inputs: `logical_path`, `version?`.

#### `membot_versions`

```
List every version of a file (newest first) with version_id, content_sha256,
size, change_note, and refresh status. Use this to find the version_id you
want to pass to membot_read or membot_diff. Tombstoned versions are included and
flagged.
```

Inputs: `logical_path`.

#### `membot_diff`

```
Return a unified-diff between two versions of a file. `a` is required; `b`
defaults to the current version. Both `a` and `b` are version_id timestamps
from membot_versions. Use to understand what a refresh actually changed before
deciding to act on the new content.
```

Inputs: `logical_path`, `a` (version_id), `b?` (version_id, default current).

#### `membot_add`

```
Ingest one or many sources. `source` accepts:
  - a local file path                  → ingests one file
  - a local directory path             → walks recursively (symlinks followed,
                                          cycles broken by realpath cache),
                                          filtered by include/exclude globs
  - a glob pattern (e.g. "docs/**/*.md")→ expands relative to cwd; symlinks
                                          followed
  - a URL                              → fetched via mcpx (the chosen server
                                          + tool + args are stored so refresh
                                          replays the exact invocation)
  - "inline:<text>"                    → stores the literal as a new file
PDF, DOCX, HTML, images, and other binaries are converted to markdown —
native libraries first, vision/OCR for images, LLM fallback for messy or
scanned input. Original bytes are kept in the blobs table; membot_read with
bytes=true returns them. Setting `refresh_frequency` enables automatic
refresh of every ingested file from the daemon. Each ingested file becomes
a NEW version under its own logical_path; existing versions stay queryable
via membot_versions. Directory/glob ingests stream one file at a time —
partial failures don't abort the rest; the response lists per-entry status.
```

Inputs: `source` (path | dir | glob | URL | `inline:` literal), `logical_path?` (defaults derived from the source itself: local entries use the entry's absolute filesystem path with the leading `/` stripped — e.g. `/Users/me/projA/README.md` → `Users/me/projA/README.md` — so two `README.md`s in different projects don't collide; URLs use `remotes/{host}/{path}` with slashes preserved; `inline:` defaults to `inline/{ts}.md`. When `logical_path` is passed explicitly on a single source, it is used verbatim; on a dir/glob ingest it is treated as a *prefix* under which entries are placed using their walk-relative path), `include?` (glob; comma-separated allowed; default `**/*`), `exclude?` (glob; default excludes `node_modules`, `.git`, `.DS_Store`, dotfiles), `follow_symlinks?` (default `true`), `refresh_frequency?` (e.g. `1h`, `24h`), `fetcher_hint?` (e.g. `firecrawl`, `github`), `change_note?`.
Output: `{ingested: [{source_path, logical_path, version_id, status, error?, mime_type, size_bytes, fetcher, source_sha256}], total, ok, failed}`.
Error hints: on `auth_error` from a fetcher, hint `Run: mcpx auth <server>`; on `unsupported_mime`, list supported types; on `nothing_matched` for a glob, suggest broadening `include` or removing `exclude`.

#### `membot_write`

```
[[ bash equivalent: tee ]] Write inline agent-authored markdown. Creates a
new version (source_type='inline') under the given logical_path. Use this
to persist agent notes, summaries, or synthesised context that should
survive across conversations. For mirroring an external document, use
membot_add with a source URL instead — that gets you refresh-on-source-change
for free.
```

Inputs: `logical_path`, `content` (markdown), `change_note?`, `refresh_frequency?` (rarely useful for inline).

#### `membot_move`

```
[[ bash equivalent: mv ]] Rename a logical_path. Creates one new version
under the new path with full content carried over and tombstones the old
path. History remains queryable under both names via membot_versions.
```

Inputs: `from_logical_path`, `to_logical_path`.

#### `membot_delete`

```
[[ bash equivalent: rm ]] Tombstone a logical_path so it no longer appears
in membot_list / membot_tree / membot_search. Old versions remain queryable via
membot_versions and membot_read with an explicit version. Use membot_prune to
permanently drop history.
```

Inputs: `logical_path`.

#### `membot_refresh`

```
Re-read a file's source and create a new version only if the source bytes
changed. Pass `logical_path` to refresh one file, or omit it to refresh
every file whose refresh_frequency_sec has elapsed. Local files are
detected via mtime+sha; remote files are re-fetched via the same mcpx
invocation that was originally used. On auth or network failure the prior
version stays current — check `last_refresh_status`.
```

Inputs: `logical_path?`, `force?` (re-embed even if sha unchanged).
Output: `{processed: [{logical_path, status, new_version_id?}]}`.

#### `membot_prune`

```
Permanently drop non-current versions older than the cutoff. Current
versions and tombstones-with-no-newer-version are preserved. Use sparingly
— pruned versions cannot be recovered.
```

Inputs: `before` (duration like `30d`, or absolute timestamp), `dry_run?` (default true).

---

## Config (`~/.membot/config.json`)

```jsonc
{
  "data_dir": "~/.membot",                                      // override MEMBOT_HOME
  "embedding_model": "Xenova/bge-small-en-v1.5",
  "embedding_dimension": 384,
  "chunker": { "mode": "deterministic", "target_chars": 4000, "max_chars": 15000 },
  "llm": {
    "anthropic_api_key": "",                                  // env: ANTHROPIC_API_KEY
    "converter_model": "claude-haiku-4-5-20251001",
    "chunker_model": "claude-haiku-4-5-20251001"
  },
  "mcpx": { "config_path": "" },                              // for remote fetchers
  "daemon": { "tick_interval_sec": 60 },
  "default_refresh_frequency_sec": null
}
```

LLM fallback is opt-out: if `ANTHROPIC_API_KEY` is missing, the converter dispatcher falls through to passthrough/error rather than calling the API.

---

## Key Dependencies (`package.json`)

Runtime:

- `@modelcontextprotocol/sdk` — MCP server (stdio + HTTP)
- `commander` — CLI parsing (CLI subcommands generated from operations via `mountAsCommanderCommand`)
- `zod-to-json-schema` — convert zod input schemas to MCP tool JSON-Schema
- `@duckdb/node-api` ^1.5.x — index + FTS + cosine
- `@huggingface/transformers` ^4.x + patched `onnxruntime-web` — local embeddings (port mcpx patch)
- `@evantahler/mcpx` — remote fetcher orchestration
- `@anthropic-ai/sdk` — LLM fallback only
- `unpdf` — bun-friendly PDF → text
- `mammoth` — DOCX → HTML/markdown
- `turndown` — HTML → markdown
- `tesseract.js` — Tesseract WASM (OCR for images and scanned PDFs)
- `picomatch` — glob expansion for `membot add` (mirror mcpx)
- `gray-matter` — frontmatter parse on inbound .md files
- `zod` ^4 — schemas
- `ansis`, `nanospinner` — output (mirror mcpx)

Dev: `@biomejs/biome`, `bun-types`.

Build: `bun build --compile --minify --sourcemap ./src/cli.ts --outfile dist/membot`. Pre-build script applies the transformers WASM patch (copy from mcpx).

---

## Verification

End-to-end smoke (run after implementation):

1. `bun install && bun run build`
2. `./dist/membot add ./README.md --path docs/readme.md` → verify row in `index.duckdb` with `source_type='local'`, `source_sha256` set, `chunks` populated.
3. `./dist/membot add https://example.com --refresh 1h` → verify `fetcher` column set (e.g. `firecrawl` or `http`), markdown content stored, `blob_sha256` set.
4. `./dist/membot add ./test/fixtures/sample.pdf` → verify converted markdown is non-empty (native unpdf path); `blobs` row holds the original PDF.
4a. `./dist/membot add ./test/fixtures/scanned.pdf` → unpdf returns empty → OCR fallback runs → markdown contains OCR'd text.
4b. `./dist/membot add ./test/fixtures/diagram.png` → vision caption + OCR folded; `description` column populated; `blobs` row holds PNG bytes.
4c. `./dist/membot read diagram.png --bytes --format raw > out.png && diff out.png ./test/fixtures/diagram.png` → byte-exact round-trip.
4d. `./dist/membot add ./docs --include "**/*.md" --include "**/*.txt" --exclude "**/node_modules/**"` → directory walk; result lists every `.md`/`.txt` ingested with its logical path; symlinks within `./docs` were followed without infinite loop.
4e. `./dist/membot add "./src/**/*.ts"` → glob pattern expanded; only matching files ingested.
5. `./dist/membot search "<query from sample>"` → returns hybrid hits with `score` and `semantic_score`.
5a. `./dist/membot search "diagram"` → the PNG ingested in 4b is in the top hits even though its raw markdown body is short — proves the description+filename prefix lifted recall.
6. `./dist/membot tree` → synthesised tree from logical paths.
7. Edit `README.md`, run `./dist/membot refresh docs/readme.md` → verify a NEW `version_id` row appears (older row preserved), `source_sha256` and `content_sha256` differ from prior version.
8. `./dist/membot refresh docs/readme.md` again (no edit) → `last_refresh_status='unchanged'`, no new version row created.
8a. `./dist/membot versions docs/readme.md` → both versions listed, newest first; `--version <old-ts>` on `membot read` returns the prior content; default `membot read` returns latest.
8b. `./dist/membot diff docs/readme.md <old-ts>` → unified diff between old and current version.
8c. `./dist/membot rm docs/readme.md` → tombstone created; `membot ls` and `membot search` no longer surface it; `membot versions` still lists history.
8d. `./dist/membot prune --before 0s --dry-run=false` → non-current versions dropped; current version + tombstone remain.
9. `./dist/membot serve` → connect with `mcpx exec` (or any MCP client) and call `membot_search` over stdio.
10. `./dist/membot serve --watch --tick 5` → modify a tracked local file; within ~5s the daemon refreshes it.
11. `bun test` — unit tests covering: converter dispatch, chunker determinism, embedder dimension, refresh sha-stable skip path, hybrid search RRF, **HelpfulError-required-hint invariant** (constructing one without a hint throws), **mount adapter error rendering** (HelpfulError → MCP isError + structuredContent; HelpfulError → CLI stderr JSON in non-interactive, colorized text in interactive), **TTY detection** (CI=true forces non-interactive; --json forces non-interactive even on TTY).
12. Spot-check interactive vs non-interactive: `./dist/membot add ./docs --include "**/*.md"` shows a progress bar in a terminal; `./dist/membot add ./docs --include "**/*.md" | cat` emits one JSON-friendly line per entry to stderr and a single result JSON to stdout, no ANSI bytes leaking through.
13. Spot-check error UX: `./dist/membot read missing.md` exits non-zero with a one-line message + concrete hint (e.g. `"Run \`membot ls\` to see available paths."`); the same call as `membot_read` over MCP returns `isError: true` with `hint` set to the same string.

Done when all 11 pass and the binary launches on darwin-arm64 without `bun` installed.
