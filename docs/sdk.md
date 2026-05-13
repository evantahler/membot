# membot SDK — programmatic use

The `membot` npm package ships both the `membot` CLI binary and a TypeScript SDK so you can drive the same operations directly from another Bun app. Most callers want the high-level `MembotClient` class — one method per CLI verb / MCP tool, schema-validated I/O, lazy connection.

## Install

```bash
bun add membot
```

The package's `postinstall` step also downloads the bundled `gws` binary into `~/.membot/bin/gws` — required only if you ingest Google Docs/Sheets/Slides. Other sources (GitHub, Linear, local files, Apple Notes) work without it.

The SDK is Bun-only (the runtime depends on `Bun.Worker`, native DuckDB bindings, and bundled WASM patches). Don't try to run it under Node.

## Quick start

```ts
import { MembotClient } from "membot";

const client = new MembotClient();

await client.add({
  sources: ["inline:Carbonara is eggs, pecorino, guanciale."],
  logical_path: "recipes/pasta.md",
});

const hits = await client.search({ query: "what's in carbonara?" });
console.log(hits.hits[0]?.logical_path);

await client.close();
```

The first method call lazily builds the underlying `AppContext` (loads `~/.membot/config.json`, opens DuckDB at `~/.membot/index.duckdb`, runs migrations). Subsequent calls reuse it. Always `close()` when done — that releases the DuckDB lock.

## `MembotClient`

### Constructor options

| Option | Default | Description |
| --- | --- | --- |
| `configFlag` | `~/.membot` (or `$MEMBOT_HOME`) | Override the data directory. Useful for embedding membot in apps that need their own store. |
| `json` | `true` | Force JSON-mode TTY detection. Embedded callers almost always want this. Set `false` if you want operations to emit color-coded stderr logs. |
| `noInteractive` | `true` | Suppress spinners and progress bars. |
| `noColor` | `true` | Strip ANSI escapes from any log output. |
| `verbose` | `false` | Forward `verbose` to the structured logger. |

### Lifecycle

| Method | Description |
| --- | --- |
| `connect(): Promise<void>` | Force-build the underlying context. Optional — methods build it lazily on first call. Call this if you want to surface init errors (config-load failures, DuckDB lock errors) before issuing real work. |
| `close(): Promise<void>` | Release the DuckDB connection. Idempotent; calls after `close()` throw a `HelpfulError`. |

### Operations

Each method maps 1:1 to a CLI verb and an MCP tool. Input and output shapes are exactly the operation's zod schemas — see `src/operations/<name>.ts` for the field-level definitions, or call `client.<method>({})` to see what zod rejects.

| Method | CLI | MCP | Purpose |
| --- | --- | --- | --- |
| `add(input)` | `membot add` | `membot_add` | Ingest one or many sources (file path, directory, glob, URL, or `inline:<text>`). |
| `list(input?)` | `membot ls` | `membot_list` | List current files under an optional prefix. |
| `tree(input?)` | `membot tree` | `membot_tree` | Render the logical-path tree of the current store. |
| `read(input)` | `membot read` | `membot_read` | Read a stored file (markdown surrogate by default; `bytes: true` for original bytes). |
| `search(input?)` | `membot search` | `membot_search` | Hybrid search (semantic + BM25, fused via RRF). |
| `info(input)` | `membot info` | `membot_info` | Inspect metadata for a file (source, fetcher, sha256s, refresh status). |
| `stats(input?)` | `membot stats` | `membot_stats` | Summarize the local index (counts, sizes, refresh health). |
| `versions(input)` | `membot versions` | `membot_versions` | List every version of a file (newest first). |
| `diff(input)` | `membot diff` | `membot_diff` | Unified diff between two versions. |
| `write(input)` | `membot write` | `membot_write` | Write inline agent-authored markdown as a new version. |
| `move(input)` | `membot mv` | `membot_move` | Rename a logical_path. |
| `remove(input)` | `membot rm` | `membot_delete` | Tombstone one or more logical_paths (literals or globs). |
| `refresh(input?)` | `membot refresh` | `membot_refresh` | Re-fetch a source (or all due sources when `logical_path` is omitted). |
| `prune(input)` | `membot prune` | `membot_prune` | Drop non-current versions older than the cutoff and GC orphan blobs. |

### Examples

```ts
// Ingest a directory recursively
await client.add({ sources: ["./docs"], include: "**/*.md" });

// Ingest a remote URL
await client.add({ sources: ["https://github.com/owner/repo/issues/42"] });

// Hybrid search: pass query for semantic, pattern for keyword, both for the strongest signal
const hits = await client.search({ query: "auth flow", pattern: "OAuth", limit: 5 });

// Read a historical version
const versions = await client.versions({ logical_path: "docs/auth.md" });
const previous = versions.versions[1]?.version_id;
if (previous) {
  const old = await client.read({ logical_path: "docs/auth.md", version: previous });
}

// Persist agent-authored notes
await client.write({
  logical_path: "agent-notes/2026-05-10.md",
  content: "# Today's findings\n\n…",
});

// Diff what a refresh changed
const v = await client.versions({ logical_path: "docs/spec.md" });
const diff = await client.diff({ logical_path: "docs/spec.md", a: v.versions[1]!.version_id });
console.log(diff.diff);
```

## Errors

Every method throws `HelpfulError` (and only `HelpfulError`) on failure. The error has three relevant fields:

| Field | Description |
| --- | --- |
| `kind` | `input_error`, `not_found`, `internal_error`, `network_error`, `auth_error`, `db_lock_error`, etc. |
| `message` | Human-readable summary of what went wrong. |
| `hint` | Concrete next action — a flag to set, a command to run, a file to inspect. The same hint string the CLI prints to stderr and the MCP server returns in `structuredContent.error`. |

```ts
import { HelpfulError, isHelpfulError } from "membot";

try {
  await client.read({ logical_path: "nope.md" });
} catch (err) {
  if (isHelpfulError(err)) {
    console.error(`[${err.kind}] ${err.message}`);
    console.error(`hint: ${err.hint}`);
  }
}
```

See `src/errors.ts` for the full type.

## Lower-level primitives

If `MembotClient` doesn't fit your shape — e.g. you're building a custom mount adapter, embedding membot in another CLI, or need to call `ingest` / `searchSemantic` / `searchKeyword` directly — the SDK also re-exports the primitives behind the client. See `src/sdk.ts` for the full export surface: `buildContext`, `closeContext`, `OPERATIONS`, the operation registry, ingest helpers, search helpers, the embedder, the refresh runner and daemon, and the MCP server factory.

## Caveats

- **Bun-only runtime.** The SDK uses `Bun.Worker` for the parallel embed pool and bundles WASM patches at install time. Node will not work.
- **First call is slow.** Operations that need embeddings (`add`, `write`, `refresh`) spawn a per-command embedder pool — typically a few hundred ms of subprocess startup. Reuse a single `MembotClient` across calls; don't construct one per request in a hot loop.
- **`~/.membot/` is shared with the CLI.** If you run `membot serve` (or the CLI) alongside an SDK-driven app, both compete for the same DuckDB file. The configured `db_lock_retry` settings apply to both. Pass `configFlag` to point at a private data directory if you want isolation.
- **`close()` is terminal.** Construct a new `MembotClient` if you need to reconnect.
