# CLAUDE.md — `membot`

Guidance for Claude Code when working in this repo. Pair with `docs/plan.md` (the source-of-truth design doc).

## What this project is

`membot` is a standalone Bun CLI + MCP server (npm package `membot`, binary `membot`) that gives AI agents a persistent, versioned, searchable context store. Files (markdown, PDF, DOCX, HTML, URLs) are ingested, converted to markdown, chunked, embedded locally with `@huggingface/transformers` (WASM, 384-dim `Xenova/bge-small-en-v1.5`), and indexed in DuckDB with hybrid search (vector + BM25). Every agent-visible artifact is a row in `files`, addressed by a virtual `logical_path` — there is **no** on-disk tree of stored content.

Reference projects (read these to understand the conventions before changing anything):

- `botholomew` — origin of the context system. The chunker, embedder, fetcher, markdown-converter, and hybrid search live in `src/context/` and `src/tools/search/`.
- `mcpx` — the project this one mirrors for layout, build, distribution, logger, and CLI shape.

## Hard constraints

- **Bun-only.** No Node-only deps. `bun build --compile` produces standalone binaries; the runtime must not require Bun installed.
- **Local embeddings only.** `@huggingface/transformers` WASM, `Xenova/bge-small-en-v1.5`, 384-dim. Never reach for cloud embedding APIs (OpenAI/Voyage/Cohere/Anthropic embeddings) even if a reference project uses them.
- **DuckDB is the only store.** Content AND original bytes live in rows (`files.content`, `blobs.bytes`), not in a filesystem tree. `~/.membot/index.duckdb` holds everything except cached model weights. The DB will get large — that's accepted.
- **Append-only versioning.** Every ingest, refresh that finds new bytes, write, or rename creates a new `(logical_path, version_id)` row. `version_id` is a `TIMESTAMP` (ms precision). Default queries flow through `current_files` / `current_chunks` views. Delete = tombstone, not a row removal.
- **MCP defaults to current.** Every MCP tool acts on the latest non-tombstoned version unless `version` is passed explicitly.
- **Mcpx invocations are persisted.** When `membot_add` fetches a remote URL via mcpx, store `fetcher_server`, `fetcher_tool`, and `fetcher_args` on the row so refresh re-invokes the exact same tool — never re-route through the agent.
- **Native conversion first, LLM fallback for messy/binary input.** `unpdf`, `mammoth`, `turndown` handle the common cases. Tesseract WASM (`tesseract.js`) does OCR for `image/*` and for PDFs whose text extraction came back empty. Claude vision captions images; Claude markdown-converter is the last-resort fallback. Missing `ANTHROPIC_API_KEY` is not a hard error — the pipeline degrades to deterministic surrogates.
- **Textual surrogate is the universal interface.** Every artifact (markdown, PDF, image, audio, anything) produces a markdown body that flows through chunking + embedding + FTS. Original bytes live in `blobs` and are reachable via `membot_read bytes=true`. Search has zero special cases for binary content.
- **Always describe.** `files.description` is generated for every ingested file, including plain markdown. The string `<logical_path>\n<description>\n\n<chunk_content>` is what gets embedded and FTS-indexed (stored as `chunks.search_text`); `chunks.chunk_content` keeps the raw body for clean snippet rendering.
- **`membot_add` accepts directories and globs.** Single arg, polymorphic: file path, directory (recursive walk, symlinks followed via realpath dedupe), glob (`docs/**/*.md`), URL, or `inline:<text>`. Each matched entry becomes its own version under its own logical_path; partial failures are reported per-entry, not all-or-nothing.
- **CLI auto-renders for the environment.** TTY → spinners, progress bars, ANSI colors. Piped/`--json`/`CI=true`/`NO_COLOR` → JSON to stdout, structured logs to stderr, no ANSI bytes. One code path; `src/output/tty.ts` is the single source of truth for which mode is active.
- **All errors are `HelpfulError`.** Bare `throw new Error(...)` is forbidden. `HelpfulError` requires a non-empty `hint` (statically and at runtime); the hint must name the next action concretely. The same hint string lands in front of both humans (CLI stderr) and LLMs (MCP `structuredContent.error.hint` and the rendered text content).

## Architecture at a glance

```
membot_add ──► local-reader OR fetcher (mcpx) ──► converter (mime dispatch)
                                                    │
                                                    ▼
                                       chunker ──► embedder (WASM)
                                                    │
                                                    ▼
                                       db.files.insertVersion + db.chunks.insertForVersion
                                                    │
                                                    ▼
                                       FTS index rebuild (current_chunks)

membot_refresh ──► re-read source ──► sha256 compare
                                       │
                          unchanged ◄──┴──► changed ──► same pipeline as membot_add
                          (status only)        (creates new version_id)
```

Daemon mode (`membot serve --watch`) ticks every `tick_interval_sec` and runs the no-arg refresh path against rows whose `refresh_frequency_sec` has elapsed.

## Layout

```
src/
  cli.ts                # commander entry; iterates operations registry
  sdk.ts                # programmatic API for embedding membot
  context.ts            # AppContext: config + db + embedder + mcpx + logger
  constants.ts          # MEMBOT_HOME, EMBEDDING_DIMENSION=384, defaults
  operations/           # ★ one file per user-facing capability; single source of truth
    types.ts            # Operation<I,O>, defineOperation()
    index.ts            # ordered registry; cli + mcp both iterate this
    add.ts list.ts tree.ts read.ts write.ts search.ts remove.ts
    move.ts refresh.ts info.ts versions.ts diff.ts prune.ts
  mount/
    mcp.ts              # mountAsMcpTool — registers an Operation as an MCP tool
    commander.ts        # mountAsCommanderCommand — registers an Operation as a CLI subcommand
    zod-to-cli.ts       # introspects zod schema → commander .argument()/.option() calls
  commands/             # CLI-only commands with no MCP equivalent (serve, reindex)
  config/               # zod schema + loader (~/.membot/config.json)
  db/                   # DuckDB connection, migrations, files.ts, chunks.ts
  ingest/               # source-resolver (file/dir/glob/url/inline), local-reader, fetcher, chunker, embedder, describer, search-text, converter/ (pdf/docx/html/image/text/ocr/llm)
  search/               # semantic.ts, keyword.ts, hybrid.ts (RRF)
  refresh/              # runner.ts (per-row), scheduler.ts (daemon)
  mcp/                  # server.ts, instructions.ts
  output/               # tty.ts (mode detection), logger.ts (spinner-aware), progress.ts (multi-entry bar), formatter.ts (table/markdown/json)
  errors.ts             # HelpfulError class — the only error type allowed in handlers
test/                   # bun test, _preload.ts applies transformers patch
patches/                # @huggingface/transformers WASM patch (copy from mcpx)
scripts/                # apply-transformers-patch.sh (pre-build hook)
docs/plan.md            # source-of-truth design
```

## Coding conventions

- **One Operation, two surfaces.** Every user-facing capability is a single `Operation` in `src/operations/` with a zod input schema, zod output schema, description string, and handler. The MCP server and the commander CLI both consume this — never write a tool description twice, never define an input shape twice. The description string is the LLM-facing docstring AND the `--help` text. Field-level help comes from `.describe()` on each zod field.
- **Zod everywhere.** Operation I/O schemas, config schema, fetcher response shapes. Use `.describe()` on every field — that text is what the agent and human both read.
- **Errors are `HelpfulError` only.** See `src/errors.ts`. Required fields: `kind`, `message`, `hint`. The constructor refuses an empty hint at runtime, and the type system refuses to omit it at compile time. The mount adapters render `kind` + `message` + `hint` for both surfaces — humans see colorized output on a TTY, LLMs get the same fields back as MCP `structuredContent.error`. Hint quality bar: name a concrete next action (a command to run, a flag to set, a path to check). Vague hints like "Check your config" should fail review.
- **No log-and-rethrow.** Errors propagate to the mount boundary, are rendered there exactly once, then exit. Logging the error before throwing produces double-output and breaks JSON-mode parseability.
- **Spinners & progress are advisory.** Operations call `ctx.progress.tick(...)` and `ctx.logger.info(...)` without checking whether they're rendered. The renderer in `src/output/` decides; non-interactive mode coerces both into stderr lines or no-ops.
- **No duplicated handlers.** If you find yourself writing logic in `src/commands/*.ts` that an MCP tool would also want, it belongs in `src/operations/` instead. The only legitimate `src/commands/*.ts` files are CLI-only behaviors with no agent-facing meaning (`serve`, `reindex`).
- **Logger, not console.** Use `src/output/logger.ts` (spinner-aware, JSON/TTY-aware). `console.log` in production code is a bug.
- **Colors via `ansis`, spinners via `nanospinner`.** Same as mcpx.
- **No premature abstractions.** Three similar lines beat a generic helper. Don't build for hypothetical fetchers, hypothetical embedders, or hypothetical storage backends.

## Tool / command descriptions

Operation descriptions are the user interface — for the LLM AND for the human running `membot <cmd> --help`. The same string is shown in both places. Every operation description follows this shape:

1. Bash-equivalent prefix where applicable: `[[ bash equivalent: cat ]]`.
2. One-line purpose.
3. When-to-use guidance — what to call before/after, what tool to prefer instead in adjacent cases.
4. Constraints, recovery hints, and links to other operations by name.

Server-level `instructions` (the string handed to the MCP client when it connects) is defined in `src/mcp/instructions.ts`. It frames the discovery → ingest → consume → write workflow and explicitly tells the agent how versioning, refresh, and the `version` parameter behave. CLI users get the same framing through `membot --help` (commander's top-level help). Update both that file and `docs/plan.md` together if you change the operation surface.

## Testing

- `bun test`. Test preload at `test/_preload.ts` applies the transformers WASM patch.
- Use a real ephemeral DuckDB file per test (don't mock the DB).
- Real fixtures for converters (`test/fixtures/sample.pdf`, `sample.docx`, `sample.html`).
- Mock the network only for fetcher tests; everything else hits the real local pipeline.
- Versioning paths to cover: insert creates v1, refresh-unchanged creates no new version, refresh-changed creates v2, `current_files` returns v2, explicit `version=v1` returns v1, tombstone hides from `current_files` but `versions` still lists it, `prune --before` drops non-current rows.

## Build & distribution

- Pre-build: `scripts/apply-transformers-patch.sh` (copy verbatim from mcpx).
- Build: `bun build --compile --minify --sourcemap ./src/cli.ts --outfile dist/membot`.
- Targets: darwin-arm64, darwin-x64, linux-arm64, linux-x64, windows-x64, windows-arm64.
- Distribution: `install.sh` / `install.ps1` mirror mcpx; published to NPM as well.

## Things to avoid

- Re-introducing a filesystem store under `~/.membot/context/`. The store is rows.
- Cloud embeddings. Local WASM only.
- Mutating an existing version's `content` / `content_sha256` / `chunks`. Those fields are immutable once the row is written — corrections are new versions.
- Re-routing a remote refresh through the LLM/agent. Replay the stored `fetcher_*` columns directly via mcpx.
- Tools that return content blobs without a `version_id` — every read-shaped response must echo which version it served.
- A separate `membot_read_blob` tool. Bytes are reachable via `membot_read` with `bytes=true`. One read tool, one mental model.
- Embedding `chunk_content` raw. Always embed `search_text` (the prepended `<path>\n<description>\n\n<body>`) — that's what `chunks.search_text` holds and what FTS is built on.
- Aborting a directory/glob ingest because one entry failed. Stream per-entry results; report failures alongside successes.
- Throwing `new Error(...)` anywhere in `src/operations/`, `src/ingest/`, `src/db/`, `src/refresh/`, or `src/mcp/`. Always `HelpfulError`. Wrap external errors with `asHelpful(cause, context, hint, kind)`.
- Writing colorized output unconditionally. Always go through `src/output/` so non-interactive callers get clean JSON.
- A `HelpfulError` whose hint just paraphrases the message ("File not found. Hint: file is missing."). Hint must name a concrete next step — a command, a flag, a path to inspect.
- **Defining a tool description in two places.** If you catch yourself writing copy in `src/mcp/...` that also exists in `src/commands/...`, stop — make it an `Operation`.
- Hand-rolling a JSON Schema for an MCP tool. Always derive it from the zod input schema via the mount adapter.

## When in doubt

Read `docs/plan.md`. If the plan and code disagree, the plan wins until a deliberate update lands in both.
