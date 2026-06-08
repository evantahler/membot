# CLAUDE.md — `membot`

Guidance for Claude Code when working in this repo. Pair with `docs/plan.md` (the source-of-truth design doc).

## What this project is

`membot` is a standalone Bun CLI + MCP server (Bun package `membot`, binary `membot`) that gives AI agents a persistent, versioned, searchable context store. Files (markdown, PDF, DOCX, HTML, URLs) are ingested, converted to markdown, chunked, embedded locally with `@huggingface/transformers` (WASM, 384-dim `Xenova/bge-small-en-v1.5`), and indexed in DuckDB with hybrid search (vector + BM25). Every agent-visible artifact is a row in `files`, addressed by a virtual `logical_path` — there is **no** on-disk tree of stored content.

Reference project (origin):

- `botholomew` — the chunker, embedder, markdown-converter, and hybrid search were originally embedded here. The earlier mcpx-based fetcher has been replaced; today's fetcher is a per-service downloader registry (see "Architecture at a glance" below).

## Hard constraints

- **Bun-only.** No Node-only deps. `bun build --compile` produces standalone binaries; the runtime must not require Bun installed.
- **Local embeddings only.** `@huggingface/transformers` WASM, `Xenova/bge-small-en-v1.5`, 384-dim. Never reach for cloud embedding APIs (OpenAI/Voyage/Cohere/Anthropic embeddings) even if a reference project uses them.
- **DuckDB is the only store.** Content AND original bytes live in rows (`files.content`, `blobs.bytes`), not in a filesystem tree. `~/.membot/index.duckdb` holds everything except cached model weights. The DB will get large — that's accepted.
- **Append-only versioning.** Every ingest, refresh that finds new bytes, write, or rename creates a new `(logical_path, version_id)` row. `version_id` is a `TIMESTAMP` (ms precision). Default queries flow through `current_files` / `current_chunks` views. Delete = tombstone, not a row removal.
- **MCP defaults to current.** Every MCP tool acts on the latest non-tombstoned version unless `version` is passed explicitly.
- **Per-service downloaders + persisted provenance.** Remote URLs are dispatched to a source-plugin registry (`src/ingest/sources/`): GitHub via REST API + PAT, Linear via GraphQL + personal API key. There is no generic-web catch-all and no Google plugin — arbitrary URLs (and Google Docs/Sheets/Slides URLs) are rejected with a clear `HelpfulError`. Each row persists `(downloader, downloader_args)` so refresh replays the exact same downloader against the same URL — deterministic, no LLM, no agent loop.
- **Fetches are non-interactive.** `membot add` and `membot refresh` never prompt or open a browser. Auth failures throw `HelpfulError` with a concrete next step (`membot config set downloaders.<svc>.api_key` for token services).
- **No Playwright, no Chromium, no Google ingest.** Membot doesn't launch a browser, embed one, or shell out to a third-party CLI. Google Docs/Sheets/Slides aren't a first-class source — the OAuth scope tax to get Drive access (either `cloud-platform` to gcloud or a manual GCP-project setup) was disproportionate. Workaround for users: export the Drive file as `.docx` / `.xlsx` / `.pdf` and `membot add <path>`.
- **Native conversion first, LLM fallback for messy/binary input.** `unpdf`, `mammoth`, `turndown` handle the common cases. Claude vision captions images; Claude markdown-converter is the last-resort fallback. Missing `ANTHROPIC_API_KEY` is not a hard error — the pipeline degrades to deterministic surrogates.
- **Textual surrogate is the universal interface.** Every artifact (markdown, PDF, image, audio, anything) produces a markdown body that flows through chunking + embedding + FTS. Original bytes live in `blobs` and are reachable via `membot_read bytes=true`. Search has zero special cases for binary content.
- **Always describe.** `files.description` is generated for every ingested file, including plain markdown. The string `<logical_path>\n<description>\n<heading-breadcrumb>\n\n<chunk_content>` is what gets embedded and FTS-indexed (stored as `chunks.search_text`); `chunks.chunk_content` keeps the raw body for clean snippet rendering. The description is capped (~240 chars) and the breadcrumb line is present only for heading-scoped markdown chunks, so the whole `search_text` fits bge-small's 512-token window.
- **Size chunks to the model window, pool the way the model was trained.** Chunk sizing (`chunker.target_chars`/`max_chars`, default 1400/1800) is budgeted so `search_text` fits bge-small's 512-token limit — oversize chunks silently embed only their prefix. BGE-v1.5 uses **CLS** pooling (`resolvePooling` in `embedder.ts`), not mean. Markdown is chunked at heading boundaries (fence-safe) with a per-chunk breadcrumb (`chunker.markdown_aware`, default on). Any change to pooling, chunk sizing, or the `search_text` shape MUST bump `EMBEDDING_REVISION` (constants.ts) with a history line; existing stores clear the resulting search-time warning by running `membot reindex --embeddings`.
- **`membot_add` accepts directories and globs.** Single arg, polymorphic: file path, directory (recursive walk, symlinks followed via realpath dedupe), glob (`docs/**/*.md`), URL, or `inline:<text>`. Each matched entry becomes its own version under its own logical_path; partial failures are reported per-entry, not all-or-nothing.
- **CLI auto-renders for the environment.** TTY → spinners, progress bars, ANSI colors. Piped/`--json`/`CI=true`/`NO_COLOR` → JSON to stdout, structured logs to stderr, no ANSI bytes. One code path; `src/output/tty.ts` is the single source of truth for which mode is active.
- **All errors are `HelpfulError`.** Bare `throw new Error(...)` is forbidden. `HelpfulError` requires a non-empty `hint` (statically and at runtime); the hint must name the next action concretely. The same hint string lands in front of both humans (CLI stderr) and LLMs (MCP `structuredContent.error.hint` and the rendered text content).
- **No `any`.** Both implicit and explicit `any` are banned (TS `strict: true` + biome `noExplicitAny: error`). For untyped third-party APIs, declare a local interface that captures the methods you actually use and cast the import once at the boundary; sprinkle `unknown` + type guards everywhere else.
- **Every method gets a docstring.** Every exported (and most internal) function, method, or class member must have a JSDoc-style comment that explains *what it does* — preferably also *why* when the rationale isn't obvious. One short line is fine for trivial wrappers; multi-line comments are appropriate for orchestration paths or anything with a non-obvious contract. Don't restate the signature; explain the intent and the contract.
- **Tests are written alongside code, not bolted on.** Every new module ships with unit tests covering the happy path, the error path, and the edge cases (empty input, malformed input, boundary conditions). DB-touching code uses real ephemeral DuckDB files, not mocks. Error types are tested for both their invariants and their rendering.
- **Migrations are logged.** Every migration applied at startup writes an `info` line so users can see what changed when they upgrade.
- **User-facing changes bump `package.json`.** Any change that ships behavior to users (new flag, new command, fixed bug they could observe, output-format change) must increment `version` in `package.json` in the same PR. The `auto-release` workflow only fires when the version changes — no bump means no release and no binaries. Internal-only refactors, comment edits, and test changes don't need a bump.

## Architecture at a glance

```
membot_add ──► local-reader OR downloader-registry ──► converter (mime dispatch)
                                                         │
                                                         ▼
                                            chunker ──► embedder (WASM; per-command
                                                         │              subprocess pool of
                                                         │              `cpus()-1` workers by
                                                         │              default — spawned at
                                                         │              the top of `add` /
                                                         │              `refresh` / `write`
                                                         │              and killed before the
                                                         │              command returns. Config
                                                         │              key `embedding.workers`)
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

For directory/glob ingests, the pipeline runs concurrently inside a worker pool. Each pMap worker owns one file end-to-end (read → unchanged check → convert → describe → chunk → embed → persist); persist is gated by an AsyncMutex because all workers share one DuckDB connection and DuckDB rejects nested BEGINs. The embed step is offloaded to a `Bun.Worker` pool — each worker hosts its own transformers ONNX session in a separate OS thread, giving real parallelism on the CPU-bound WASM step. Worker count defaults to `cpus - 1`, capped at `MAX_WORKERS = 8`, and is further clamped by entry count so a 3-file batch doesn't spawn 8 threads. One `rebuildFts` runs after the pool drains. The TTY shows a multi-line spinner: top line = bar + counts + ETA + cumulative chunks; below = one row per active worker showing `path — current step`.

The downloader registry maps URLs to a tactic:

| Service | Match | Strategy | Auth |
|---|---|---|---|
| github | `github.com/<owner>/<repo>/(issues\|pull)/<n>` | `api.github.com/repos/.../issues/<n>` + `/comments` → render JSON to markdown | `downloaders.github.api_key` PAT (or `GITHUB_TOKEN`); public repos work unauth at 60 req/hr |
| github-repo | scheme `github-repo:<owner>/<repo>[:<selector>]` | paginated `/repos/<o>/<r>/issues?state=…` → one Entry per issue/PR, fetched via the same path as `github` | Shares `downloaders.github.api_key` (or `GITHUB_TOKEN`) |
| linear | `linear.app/<workspace>/issue/<KEY>` and `…/project/<slug>` | `api.linear.app/graphql` (Issue / Project queries) → render JSON to markdown | `downloaders.linear.api_key` personal API key |
| linear-team | scheme `linear-team:<TEAM_KEY>` | paginated GraphQL `teams` → `projects` → `issues` → one Entry per project/issue, fetched via the same path as `linear` | Shares `downloaders.linear.api_key` |

There is **no** generic-web catch-all and **no** Google ingest. Arbitrary http(s) URLs that no plugin claims (including `docs.google.com/...`) produce a clear `HelpfulError` telling the user to download the file locally and `membot add <path>`. GitHub + Linear are pure HTTP — no plugin opens a browser, shells out to a third-party CLI, or needs Playwright.

Daemon mode (`membot serve --watch`) ticks every `tick_interval_sec` and runs the no-arg refresh path against rows whose `refresh_frequency_sec` has elapsed.

## Layout

```
src/
  cli.ts                # commander entry; iterates operations registry
  sdk.ts                # programmatic API for embedding membot
  context.ts            # AppContext: config + db + embedder + logger
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
  commands/             # CLI-only commands with no MCP equivalent (serve, reindex, login)
  config/               # zod schema + loader (~/.membot/config.json)
  db/                   # DuckDB connection, migrations, files.ts, chunks.ts
  ingest/               # source-resolver (file/dir/glob/url/inline), local-reader, fetcher, chunker, embedder, describer, search-text, concurrency (pMap + AsyncMutex), embed-pool / embed-worker (Bun.Worker pool for parallel embed), converter/ (pdf/docx/html/image/text/llm), sources/ (per-service: github, linear, apple-notes)
  search/               # semantic.ts, keyword.ts, hybrid.ts (RRF)
  refresh/              # runner.ts (per-row), scheduler.ts (daemon)
  mcp/                  # server.ts, instructions.ts
  output/               # tty.ts (mode detection), logger.ts (spinner-aware), progress.ts (multi-entry bar), formatter.ts (table/markdown/json)
  errors.ts             # HelpfulError class — the only error type allowed in handlers
test/                   # bun test, _preload.ts applies transformers patch
patches/                # @huggingface/transformers WASM patch
scripts/                # apply-patches.sh (pre-build hook — applies all node_modules patches)
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
- **Colors via `ansis`, spinners via `nanospinner`.**
- **No premature abstractions.** Three similar lines beat a generic helper. Don't build for hypothetical fetchers, hypothetical embedders, or hypothetical storage backends.

## Tool / command descriptions

Operation descriptions are the user interface — for the LLM AND for the human running `membot <cmd> --help`. The same string is shown in both places. Every operation description follows this shape:

1. Bash-equivalent prefix where applicable: `[[ bash equivalent: cat ]]`.
2. One-line purpose.
3. When-to-use guidance — what to call before/after, what tool to prefer instead in adjacent cases.
4. Constraints, recovery hints, and links to other operations by name.

Server-level `instructions` (the string handed to the MCP client when it connects) is defined in `src/mcp/instructions.ts`. It frames the discovery → ingest → consume → write workflow and explicitly tells the agent how versioning, refresh, and the `version` parameter behave. CLI users get the same framing through `membot --help` (commander's top-level help). Update both that file and `docs/plan.md` together if you change the operation surface.

## User-facing docs and agent skills MUST stay in sync

Three files are the public face of the project. Whenever you change the operation surface, command names, flags, install steps, or env vars, update **all three** in the same change:

- `README.md` — the user-facing entry point on GitHub.
- `.claude/skills/membot.md` — the Claude Code skill (bundled into the binary via Bun text imports and shipped via `membot skill install --claude`).
- `.cursor/rules/membot.mdc` — the Cursor rule (bundled the same way, shipped via `membot skill install --cursor`).

If a command, flag, or workflow changes, the README command table, the skill command tables, and the workflow sections must all reflect the new shape. Drift between these and the actual CLI is a bug. The skill files are imported via `import ... with { type: "text" }` in `src/commands/skill.ts`, so a stale file in `.claude/` or `.cursor/` ships to every user the moment they upgrade.

## Testing

- `bun test`. Test preload at `test/_preload.ts` applies the transformers WASM patch.
- **Bun runs test files sequentially by default**, in a single process. Parallel execution is opt-in via `--parallel=<n>` (creates that many worker processes). Cross-test flakes therefore come from shared in-process state — module-level singletons, leaked file handles, leftover global DuckDB state — not from concurrent file-system contention.
- Use a real ephemeral DuckDB file per test (don't mock the DB).
- Real fixtures for converters (`test/fixtures/sample.pdf`, `sample.docx`, `sample.html`).
- Mock the network only for fetcher tests; everything else hits the real local pipeline.
- Versioning paths to cover: insert creates v1, refresh-unchanged creates no new version, refresh-changed creates v2, `current_files` returns v2, explicit `version=v1` returns v1, tombstone hides from `current_files` but `versions` still lists it, `prune --before` drops non-current rows.

## Build & distribution

- Pre-build: `scripts/apply-patches.sh` (applies the transformers WASM patch).
- Build: `bun build --compile --minify --sourcemap --external '@duckdb/*' --external 'macos-ts' ./src/cli.ts --outfile dist/membot`. `@duckdb/*` is externalized because DuckDB ships per-platform `.node` bindings that `bun build --compile` can't bundle. The bundled `gws` CLI is fetched by the `postinstall` script (`scripts/install-gws.ts`) into `~/.membot/bin/gws` — it lives next to the membot binary, not inside it.
- Targets: darwin-arm64, darwin-x64, linux-arm64, linux-x64, windows-x64, windows-arm64.

## Things to avoid

- Re-introducing a filesystem store under `~/.membot/context/`. The store is rows.
- Cloud embeddings. Local WASM only.
- Mutating an existing version's `content` / `content_sha256` / `chunks`. Those fields are immutable once the row is written — corrections are new versions.
- Re-routing a remote refresh through an LLM/agent loop. Refresh looks up the persisted `downloader` name and re-invokes the same downloader against `source_path` — deterministic, no LLM call.
- Opening a browser, prompting on stdin, or otherwise blocking during a fetch. `membot add` and `membot refresh` MUST stay non-interactive (the daemon depends on it). `membot login` is just an informational printout.
- Re-introducing Playwright or any embedded browser. All current plugins are pure HTTP (GitHub, Linear) or pure local (Apple Notes).
- Adding Google Docs/Sheets/Slides ingest. Google's OAuth scope requirements make it a poor fit (you need `cloud-platform` via gcloud or a self-managed GCP project/OAuth client). Users export from Drive as `.docx`/`.xlsx`/`.pdf` and use `membot add <path>`.
- Tools that return content blobs without a `version_id` — every read-shaped response must echo which version it served.
- A separate `membot_read_blob` tool. Bytes are reachable via `membot_read` with `bytes=true`. One read tool, one mental model.
- Embedding `chunk_content` raw. Always embed `search_text` (the prepended `<path>\n<description>\n<breadcrumb>\n\n<body>`) — that's what `chunks.search_text` holds and what FTS is built on.
- Mean-pooling BGE, or sizing chunks past the 512-token window. Both silently degrade vectors. Changing the embedding scheme without bumping `EMBEDDING_REVISION` is the related process bug — stores never learn they're stale.
- Aborting a directory/glob ingest because one entry failed. Stream per-entry results; report failures alongside successes.
- Throwing `new Error(...)` anywhere in `src/operations/`, `src/ingest/`, `src/db/`, `src/refresh/`, or `src/mcp/`. Always `HelpfulError`. Wrap external errors with `asHelpful(cause, context, hint, kind)`.
- Writing colorized output unconditionally. Always go through `src/output/` so non-interactive callers get clean JSON.
- A `HelpfulError` whose hint just paraphrases the message ("File not found. Hint: file is missing."). Hint must name a concrete next step — a command, a flag, a path to inspect.
- **Defining a tool description in two places.** If you catch yourself writing copy in `src/mcp/...` that also exists in `src/commands/...`, stop — make it an `Operation`.
- Hand-rolling a JSON Schema for an MCP tool. Always derive it from the zod input schema via the mount adapter.

## When in doubt

Read `docs/plan.md`. If the plan and code disagree, the plan wins until a deliberate update lands in both.
