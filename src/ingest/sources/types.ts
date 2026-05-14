import type { z } from "zod";
import type { MembotConfig } from "../../config/schemas.ts";
import type { logger as Logger } from "../../output/logger.ts";

/**
 * The shape every source fetch produces. `downloader` + `downloaderArgs`
 * get persisted on the row so refresh can replay the same plugin against
 * the same source deterministically (no LLM, no agent loop).
 */
export interface DownloadedRemote {
	bytes: Uint8Array;
	sha256: string;
	mimeType: string;
	downloader: string;
	downloaderArgs: Record<string, unknown>;
	sourceUrl: string;
}

/**
 * Per-call context passed to every plugin method. `onProgress` is the
 * spinner sublabel hook — plugins call it with short status strings
 * during multi-step fetches.
 */
export interface PluginCtx {
	logger: typeof Logger;
	config: MembotConfig;
	onProgress?: (sublabel: string) => void;
}

/**
 * Narrow context handed to `enumerate`. Enumeration runs in the resolve
 * phase before a BrowserPool exists, so this is strictly `{ config, logger }`.
 * Bulk-import scheme plugins (linear-team, github-repo) read API keys from
 * `config.downloaders.<key>.api_key` to paginate listing endpoints; URL +
 * filesystem plugins ignore the arg.
 */
export interface EnumerateCtx {
	config: MembotConfig;
	logger: typeof Logger;
}

/**
 * One unit of work the plugin asks the orchestrator to ingest. URL plugins
 * yield one Entry per source (the URL itself). Scheme plugins like
 * `apple-notes:` enumerate many entries per source — one per matched note.
 *
 * - `source` is persisted as `files.source_path` and is what gets passed
 *   back to `rehydrateEntry` at refresh time.
 * - `logicalPathHint` is the default logical_path for this entry; the host
 *   may override it via `--logical-path` / multi-source prefix logic.
 * - `cursor` is an opaque-to-host payload that gets persisted as
 *   `files.downloader_args` and re-supplied to refresh via `rehydrateEntry`.
 * - `mtimeMs`, if known cheaply at enumerate time, lets the orchestrator
 *   short-circuit the fetch when the persisted `source_mtime_ms` matches.
 *   Apple Notes uses this to skip protobuf decoding for untouched notes.
 */
export interface Entry<A extends Record<string, unknown> = Record<string, unknown>> {
	source: string;
	logicalPathHint: string;
	cursor: A;
	mtimeMs?: number;
}

/**
 * Persisted state visible to `probeUnchanged`. The plugin compares
 * something cheap (a remote mtime, an etag) against these stored values
 * before going to the trouble of actually fetching.
 */
export interface ProbeContext {
	source_mtime_ms: number | null;
	source_sha256: string | null;
}

/**
 * One open batch (sqlite reader, GraphQL client, …) shared
 * across many fetches in a single ingest run. The orchestrator opens one
 * per source via `plugin.openBatchFetcher`, runs N fetches against it,
 * then closes it. URL plugins don't need this and return a trivial
 * fetcher whose `close()` is a no-op.
 */
export interface BatchFetcher<A extends Record<string, unknown> = Record<string, unknown>> {
	fetch(entry: Entry<A>, ctx: PluginCtx): Promise<DownloadedRemote>;
	close(): Promise<void>;
}

/**
 * Subset of the host AppContext that `sync` implementations need: a DB
 * handle, the loaded config (so plugins that re-enumerate the source —
 * linear-team, github-repo — can read their API key), and a logger.
 * Kept narrow so plugins can be unit-tested against a synthetic context
 * without needing a full AppContext.
 */
export interface SyncCtx {
	db: import("../../db/connection.ts").DbConnection;
	config: MembotConfig;
	logger: typeof Logger;
}

export type LoginEntry = ApiKeyLoginEntry;

export interface ApiKeyLoginEntry {
	kind: "api_key";
	/** Display name (e.g. "Linear"). */
	name: string;
	/** Settings page where the user creates the key. */
	url: string;
	/** Shell command the user copies — e.g. `membot config set linear.api_key <KEY>`. */
	setupCommand: string;
	/** Optional one-liner shown next to the link. */
	description?: string;
}

/**
 * How a plugin claims a source string.
 *  - `url`: the source parses as an http(s) URL and the plugin's
 *    `matches(url)` returns true. Tried in registration order after
 *    every scheme matcher.
 *  - `scheme`: the source starts with `prefix` (e.g. `apple-notes:`).
 *    Scheme matchers are tried first so a scheme source never falls
 *    through to URL matching.
 *  - `dynamic`: the plugin consults the live config to decide whether
 *    to claim the URL (e.g. the `custom-command` plugin iterates the
 *    user-defined router list). Dynamic matchers run AFTER every static
 *    URL matcher so built-in plugins always win on overlapping patterns,
 *    and they only run for inputs that parse as URLs.
 */
export type SourceMatch =
	| { kind: "url"; matches: (url: URL) => boolean }
	| { kind: "scheme"; prefix: string }
	| { kind: "dynamic"; matches: (url: URL, config: MembotConfig) => boolean };

/**
 * Plugin config-slice declaration. Used to assemble
 * `MembotConfigSchema.downloaders` at startup. Only plugins with their own
 * persisted settings (api_key, base_url overrides, etc.) declare this —
 * CLI-tool-auth plugins like Google Docs have `logins` but no config slice
 * (credentials live wherever the bundled CLI keeps them).
 */
export interface PluginConfigSlice<C extends Record<string, unknown> = Record<string, unknown>> {
	/** Key under `config.downloaders`. Plugin's slice lives at `config.downloaders[key]`. */
	key: string;
	/** Per-plugin zod object schema; gets `.default()` applied at composition time. */
	schema: z.ZodObject<{ [K in keyof C]: z.ZodType<C[K]> }>;
}

/**
 * A registered ingest source. Adding a new source = one file with a
 * `defineSourcePlugin({...})` value + one side-effect import in
 * `src/ingest/sources/index.ts`. URL-pattern matchers and scheme-prefix
 * matchers share the same shape; multi-entry sources (apple-notes)
 * differ from single-entry ones only by what their `enumerate` returns.
 */
export interface SourcePlugin<
	C extends Record<string, unknown> = Record<string, unknown>,
	A extends Record<string, unknown> = Record<string, unknown>,
> {
	/** Stable id; persisted as `files.downloader`. Refresh looks this up. */
	name: string;
	/** One-line LLM/human help. Shown in `membot add --help` and `membot sources`. */
	description: string;
	/**
	 * Concrete example sources users can copy-paste. Drives the docs codegen
	 * (README, skill files) and the `--help` rendering.
	 */
	examples: string[];
	/**
	 * Optional longer prose paragraph for the README / skill sections.
	 * Use for caveats: rate limits, platform constraints, what's excluded.
	 */
	notes?: string;

	match: SourceMatch;

	/**
	 * Login UI entries the plugin needs the user to complete before its
	 * fetches will succeed. `membot login` collects these across every
	 * plugin and dedupes by URL — e.g. `github` and `github-repo` share
	 * one GitHub api_key entry.
	 */
	logins?: LoginEntry[];

	/**
	 * Per-plugin slice of `config.downloaders`. Required for plugins with
	 * runtime settings (api_key); omit for plugins with no auth (e.g.
	 * apple-notes reads NoteStore.sqlite directly).
	 */
	config?: PluginConfigSlice<C>;

	/**
	 * Restrict registration to specific Node platforms. apple-notes is
	 * `["darwin"]`; everything else omits this. Registry silently skips a
	 * plugin whose platform doesn't match `process.platform`.
	 */
	platform?: NodeJS.Platform[];

	/**
	 * Walk the source and produce one entry per ingestable thing. URL
	 * plugins typically return a single entry whose `source` is the URL.
	 * Scheme plugins like `apple-notes:` enumerate many notes per call.
	 *
	 * Runs in the resolve phase before the host builds a full PluginCtx,
	 * but receives a narrow `EnumerateCtx` carrying `config` + `logger`
	 * so bulk-import schemes (linear-team, github-repo) can hit listing
	 * APIs and paginate. Plugins that don't need network for enumeration
	 * ignore the arg; plugins that need richer context defer that work
	 * into `openBatchFetcher.fetch` instead.
	 */
	enumerate: (source: string, ctx: EnumerateCtx) => Promise<Entry<A>[]>;

	/**
	 * Open a batch fetcher. The orchestrator calls this once per source,
	 * runs N fetches against it, then `close()`s it. URL plugins return
	 * a stateless fetcher whose close is a no-op; apple-notes returns a
	 * fetcher that holds a sqlite reader open across the batch.
	 */
	openBatchFetcher: (ctx: PluginCtx) => Promise<BatchFetcher<A>>;

	/**
	 * Reconstitute an Entry from its persisted (source, downloader_args).
	 * Refresh calls this to recreate the Entry before invoking fetch on a
	 * one-shot BatchFetcher.
	 */
	rehydrateEntry: (source: string, args: A) => Entry<A>;

	/**
	 * Optional cheap pre-fetch unchanged probe. Returns true when the host
	 * can skip fetch entirely. Apple Notes uses this to compare the live
	 * `modifiedAt` against the persisted `source_mtime_ms` before reading
	 * the gzip'd protobuf body.
	 */
	probeUnchanged?: (entry: Entry<A>, persisted: ProbeContext) => boolean;

	/**
	 * Optional sync helper. Tombstone rows whose underlying entries no
	 * longer exist at the source. Implementations own the whole reconcile:
	 * enumerate live entries, scan the relevant rows in `ctx.db`, and call
	 * `tombstone()` on every row that's gone. Returns the logical_paths
	 * tombstoned so the host can surface them in the response.
	 *
	 * Plugins without a way to enumerate the full source set (URL plugins
	 * with single-entry semantics) omit this entirely — the `--sync` flag
	 * becomes a no-op for those sources.
	 */
	sync?: (ctx: SyncCtx, source: string) => Promise<{ tombstoned: string[] }>;
}

/**
 * Helper for terse plugin definitions. Mirrors `defineOperation` so the
 * patterns rhyme.
 */
export function defineSourcePlugin<
	C extends Record<string, unknown> = Record<string, unknown>,
	A extends Record<string, unknown> = Record<string, unknown>,
>(plugin: SourcePlugin<C, A>): SourcePlugin<C, A> {
	return plugin;
}
