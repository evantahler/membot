import { DEFAULTS } from "../constants.ts";
import type { AppContext } from "../context.ts";
import { upsertBlob } from "../db/blobs.ts";
import { insertChunksForVersion, rebuildFts } from "../db/chunks.ts";
import { type FetcherKind, getCurrent, insertVersion, millisIso, type SourceType } from "../db/files.ts";
import { asHelpful, HelpfulError } from "../errors.ts";
import { pieFor } from "../output/progress.ts";
import { chunkDeterministic } from "./chunker.ts";
import { AsyncMutex, pMap } from "./concurrency.ts";
import { convert } from "./converter/index.ts";
import { describe } from "./describer.ts";
import { embed } from "./embedder.ts";
import { fetchRemote } from "./fetcher.ts";
import { readLocalFile, sha256Hex } from "./local-reader.ts";
import { buildSearchText } from "./search-text.ts";
import { type ResolvedLocalEntry, type ResolvedSource, resolveSource } from "./source-resolver.ts";

export interface IngestInput {
	source: string;
	logical_path?: string;
	include?: string;
	exclude?: string;
	follow_symlinks?: boolean;
	refresh_frequency?: string;
	downloader?: string;
	change_note?: string;
	force?: boolean;
}

export interface IngestEntryResult {
	source_path: string;
	logical_path: string;
	version_id: string | null;
	status: "ok" | "unchanged" | "failed";
	error?: string;
	mime_type: string | null;
	size_bytes: number;
	chunk_count: number | null;
	fetcher: FetcherKind;
	source_sha256: string;
}

export interface IngestResult {
	ingested: IngestEntryResult[];
	total: number;
	ok: number;
	unchanged: number;
	failed: number;
}

/**
 * Per-entry hooks invoked while a resolved source is being ingested. Used by
 * `add` to drive a single shared progress reporter across many sources
 * without re-resolving anything. `onEntryStart` fires before the pipeline
 * touches an entry; `onEntryComplete` fires after the result (ok / unchanged
 * / failed) is known. Both are optional.
 *
 * The optional `workerId` arg threads the slot index through so the UI can
 * show one status line per in-flight worker; callers that don't want that
 * detail simply ignore it.
 */
export interface IngestCallbacks {
	onEntryStart?: (label: string, workerId?: number) => void;
	onEntryComplete?: (entry: IngestEntryResult, workerId?: number) => void;
	/**
	 * Fires for sub-step progress within a single entry (e.g. "embedding
	 * 32/168"). The callback runs many times per entry and is intended for
	 * driving an interactive spinner — non-interactive callers should ignore
	 * it to avoid log spam.
	 */
	onEntryProgress?: (label: string, sublabel: string, workerId?: number) => void;
	/**
	 * Fires once after the worker pool size has been determined, before the
	 * first entry begins. Lets the progress reporter size its per-worker
	 * status section.
	 */
	onWorkerCount?: (n: number) => void;
	/**
	 * Fires after each successful persist with the number of new chunks
	 * written, so the progress reporter can track a running total.
	 */
	onChunks?: (n: number) => void;
}

/**
 * Count how many per-entry results a `ResolvedSource` will produce. Used by
 * `add` to size a shared progress bar before ingestion starts.
 */
export function countResolvedEntries(resolved: ResolvedSource): number {
	if (resolved.kind === "local-files") return resolved.entries.length;
	return 1;
}

/**
 * Top-level ingest orchestrator. Resolves the source arg, dispatches to the
 * right reader (local / remote / inline), runs the pipeline (convert →
 * describe → chunk → embed → write), and returns one entry per matched
 * file. Partial failures are reported per-entry; the entire call doesn't
 * abort because one URL or PDF is bad. Drives `ctx.progress` itself, so
 * single-source SDK callers get a usable indicator out of the box. When
 * orchestrating many sources at once (e.g. `add`), call `resolveSource` +
 * `ingestResolved` directly so one shared progress spans every entry.
 */
export async function ingest(input: IngestInput, ctx: AppContext): Promise<IngestResult> {
	const resolved = await resolveSource(input.source, {
		include: input.include,
		exclude: input.exclude,
		followSymlinks: input.follow_symlinks ?? true,
	});
	const total = countResolvedEntries(resolved);
	ctx.progress.start(total, "ingest");
	const callbacks: IngestCallbacks = {
		// Tick on completion so the bar reflects done-and-persisted entries,
		// not concurrently-in-flight ones. setLabel shows the in-flight file
		// without advancing the count; sub-step suffix flows via update; per-
		// worker status lines + chunk total light up if the reporter supports
		// them (multi-line UI in TTY, no-op otherwise). The pie glyph fills
		// in as the per-file pipeline marches read → … → persist.
		onWorkerCount: (n) => ctx.progress.setWorkers(n),
		onEntryStart: (label, workerId) => {
			if (workerId !== undefined) ctx.progress.workerSet(workerId, `${pieFor(undefined)} ${label}`);
			ctx.progress.setLabel(label);
		},
		onEntryComplete: (entry, workerId) => {
			if (workerId !== undefined) ctx.progress.workerSet(workerId, "");
			ctx.progress.tick(entry.logical_path);
		},
		onEntryProgress: (label, sublabel, workerId) => {
			if (workerId !== undefined) ctx.progress.workerSet(workerId, `${pieFor(sublabel)} ${label} — ${sublabel}`);
			ctx.progress.update(sublabel);
		},
		onChunks: (n) => ctx.progress.addChunks(n),
	};
	const result = await ingestResolved(resolved, input, ctx, callbacks);
	const okCount = result.ok;
	const unchangedSuffix = result.unchanged > 0 ? ` (${result.unchanged} unchanged)` : "";
	ctx.progress.done(`ingested ${okCount}/${result.total}${unchangedSuffix}`);
	return result;
}

/**
 * Run the ingest pipeline against a pre-resolved source. Same as `ingest`
 * but skips the resolve step and delegates progress reporting to the caller
 * via `callbacks`. This is the entry point used by multi-source orchestrators
 * (`add`) so a single progress bar can span every entry across every source.
 */
export async function ingestResolved(
	resolved: ResolvedSource,
	input: IngestInput,
	ctx: AppContext,
	callbacks?: IngestCallbacks,
): Promise<IngestResult> {
	const refreshSec = parseDuration(input.refresh_frequency);
	const force = input.force === true;

	if (resolved.kind === "inline") {
		return ingestInline(resolved.text, input, ctx, refreshSec, callbacks);
	}
	if (resolved.kind === "url") {
		return ingestUrl(resolved.url, input, ctx, refreshSec, force, callbacks);
	}
	return ingestLocalFiles(resolved, input, ctx, refreshSec, force, callbacks);
}

/** Ingest a single inline blob (source_type='inline'). */
async function ingestInline(
	text: string,
	input: IngestInput,
	ctx: AppContext,
	refreshSec: number | null,
	callbacks?: IngestCallbacks,
): Promise<IngestResult> {
	const logicalPath = input.logical_path ?? defaultInlinePath();
	callbacks?.onEntryStart?.(logicalPath);
	const bytes = new TextEncoder().encode(text);
	const sha = sha256Hex(bytes);
	const result: IngestEntryResult = {
		source_path: "inline:",
		logical_path: logicalPath,
		version_id: null,
		status: "ok",
		mime_type: "text/markdown",
		size_bytes: bytes.byteLength,
		chunk_count: null,
		fetcher: "inline",
		source_sha256: sha,
	};
	try {
		const persisted = await persistVersion(
			ctx,
			{
				logicalPath,
				sourceType: "inline",
				sourcePath: null,
				sourceMtimeMs: null,
				sourceSha: sha,
				blobSha: null,
				mime: "text/markdown",
				bytes: null,
				markdown: text,
				fetcher: "inline",
				downloader: null,
				downloaderArgs: null,
				refreshSec,
				changeNote: input.change_note ?? null,
			},
			(sublabel) => callbacks?.onEntryProgress?.(logicalPath, sublabel),
		);
		result.version_id = persisted.versionId;
		result.chunk_count = persisted.chunkCount;
	} catch (err) {
		result.status = "failed";
		result.error = errorMessage(err);
	}
	callbacks?.onEntryComplete?.(result);
	return summarize([result]);
}

/** Ingest one URL (source_type='remote'). */
async function ingestUrl(
	url: string,
	input: IngestInput,
	ctx: AppContext,
	refreshSec: number | null,
	force: boolean,
	callbacks?: IngestCallbacks,
): Promise<IngestResult> {
	const logicalPath = input.logical_path ?? defaultLogicalForUrl(url);
	callbacks?.onEntryStart?.(url);
	const result: IngestEntryResult = {
		source_path: url,
		logical_path: logicalPath,
		version_id: null,
		status: "ok",
		mime_type: null,
		size_bytes: 0,
		chunk_count: null,
		fetcher: "downloader",
		source_sha256: "",
	};

	try {
		callbacks?.onEntryProgress?.(url, "fetching");
		const fetched = await fetchRemote(
			url,
			ctx.config,
			{
				downloaderName: input.downloader,
				onProgress: (sublabel) => callbacks?.onEntryProgress?.(url, sublabel),
			},
			ctx.dataDir,
		);
		result.mime_type = fetched.mimeType;
		result.size_bytes = fetched.bytes.byteLength;
		result.fetcher = "downloader";
		result.source_sha256 = fetched.sha256;

		if (!force) {
			const cur = await getCurrent(ctx.db, logicalPath);
			if (cur && cur.source_sha256 === fetched.sha256) {
				result.status = "unchanged";
				result.version_id = cur.version_id;
				callbacks?.onEntryComplete?.(result);
				return summarize([result]);
			}
		}

		const persisted = await pipelineForBytes(
			ctx,
			{
				logicalPath,
				bytes: fetched.bytes,
				mime: fetched.mimeType,
				source: url,
				sourceType: "remote",
				sourcePath: url,
				sourceMtimeMs: null,
				sourceSha: fetched.sha256,
				fetcher: "downloader",
				downloader: fetched.downloader,
				downloaderArgs: fetched.downloaderArgs,
				refreshSec,
				changeNote: input.change_note ?? null,
			},
			(sublabel) => callbacks?.onEntryProgress?.(url, sublabel),
		);
		result.version_id = persisted.versionId;
		result.chunk_count = persisted.chunkCount;
	} catch (err) {
		result.status = "failed";
		result.error = errorMessage(err);
	}
	callbacks?.onEntryComplete?.(result);
	return summarize([result]);
}

/** Ingest a list of local files (source_type='local'). One transaction per entry. */
async function ingestLocalFiles(
	resolved: Extract<ResolvedSource, { kind: "local-files" }>,
	input: IngestInput,
	ctx: AppContext,
	refreshSec: number | null,
	force: boolean,
	callbacks?: IngestCallbacks,
): Promise<IngestResult> {
	if (resolved.entries.length === 0) {
		// `filtered: true` means the source resolved successfully but every
		// entry was dropped by --exclude / --include / DEFAULT_EXCLUDES.
		// Treat that as a silent no-op: shell-expanded globs commonly hand
		// us individual files we should skip without aborting the batch.
		if (resolved.filtered) {
			return { ingested: [], total: 0, ok: 0, unchanged: 0, failed: 0 };
		}
		throw new HelpfulError({
			kind: "input_error",
			message: `Glob/path matched 0 files`,
			hint: `Try a broader pattern (e.g. ./**/*.md) or relax --exclude.`,
		});
	}

	const isMulti = resolved.entries.length > 1;
	// Cap worker count by the actual file count so tiny batches don't pay
	// the cost of spawning N threads (each loads ~130MB of model weights);
	// also clamp by config and the global MAX_WORKERS ceiling.
	const configured = Math.min(DEFAULTS.MAX_WORKERS, Math.max(1, ctx.config.ingest.worker_concurrency));
	const workerCount = Math.max(1, Math.min(configured, resolved.entries.length));
	callbacks?.onWorkerCount?.(workerCount);
	const persistMutex = new AsyncMutex();
	let anyOk = false;

	// Each pMap worker pulls a file from the shared queue and runs the
	// entire pipeline end-to-end (read → unchanged check → convert →
	// describe → chunk → embed → persist). The persist phase is gated by a
	// single mutex because all workers share one DuckDB connection and
	// DuckDB rejects nested BEGINs. The embed step itself fans out across
	// the per-command embedder subprocess pool that `add` / `refresh`
	// register via `withEmbedderPool()` — so the WASM call truly
	// parallelizes across cores instead of serializing on the main JS
	// event loop. When that pool isn't registered (single-shot SDK call,
	// `embedding.workers = 1`), embed() runs inline against the in-process
	// extractor with no IPC overhead.
	const outcomes = await pMap(resolved.entries, workerCount, async (entry, _index, workerId) => {
		const logicalPath = pickLogicalPath(input.logical_path, entry, isMulti);
		const result: IngestEntryResult = {
			source_path: entry.absPath,
			logical_path: logicalPath,
			version_id: null,
			status: "ok",
			mime_type: null,
			size_bytes: 0,
			chunk_count: null,
			fetcher: "local",
			source_sha256: "",
		};
		callbacks?.onEntryStart?.(entry.relPathFromBase, workerId);
		const onPhase = (sublabel: string) => callbacks?.onEntryProgress?.(entry.relPathFromBase, sublabel, workerId);
		try {
			onPhase("reading");
			const local = await readLocalFile(entry.absPath);
			result.mime_type = local.mimeType;
			result.size_bytes = local.sizeBytes;
			result.source_sha256 = local.sha256;

			if (!force) {
				const cur = await getCurrent(ctx.db, logicalPath);
				if (cur && cur.source_sha256 === local.sha256) {
					result.status = "unchanged";
					result.version_id = cur.version_id;
					callbacks?.onEntryComplete?.(result, workerId);
					return result;
				}
			}

			onPhase("converting");
			const conversion = await convert(
				local.bytes,
				local.mimeType,
				entry.absPath,
				ctx.config.llm,
				ctx.config.converters,
			);
			const markdown = conversion.markdown;

			onPhase("describing");
			const description = await describe(logicalPath, local.mimeType, markdown, ctx.config.llm);

			onPhase("chunking");
			const chunks = chunkDeterministic(markdown, ctx.config.chunker);
			const searchTexts = chunks.map((c) => buildSearchText(logicalPath, description, c.content));

			let embeddings: number[][];
			try {
				embeddings = await embed(searchTexts, ctx.config.embedding_model, {
					onProgress: (done, total) => onPhase(`embedding ${done}/${total}`),
				});
			} catch (err) {
				throw asHelpful(
					err,
					`while embedding chunks for ${logicalPath}`,
					"Run `bun run prebuild` to apply the transformers WASM patch, or set a different config.embedding_model.",
				);
			}

			const versionId = await persistMutex.lock(async () => {
				onPhase("persisting");
				return persistOne(ctx, {
					logicalPath,
					sourceType: "local",
					sourcePath: entry.absPath,
					sourceMtimeMs: local.mtimeMs,
					sourceSha: local.sha256,
					blobSha: local.sha256,
					mime: local.mimeType,
					bytes: local.bytes,
					markdown,
					description,
					chunks,
					searchTexts,
					embeddings,
					fetcher: "local",
					downloader: null,
					downloaderArgs: null,
					refreshSec,
					changeNote: input.change_note ?? null,
				});
			});
			result.version_id = versionId;
			result.chunk_count = chunks.length;
			anyOk = true;
			callbacks?.onChunks?.(chunks.length);
		} catch (err) {
			result.status = "failed";
			result.error = errorMessage(err);
		}
		callbacks?.onEntryComplete?.(result, workerId);
		return result;
	});

	const results: IngestEntryResult[] = outcomes.map((o) => {
		if (o.ok) return o.value;
		// pMap caught a worker rejection — shouldn't happen since the worker
		// catches its own errors, but surface defensively.
		return {
			source_path: "",
			logical_path: "",
			version_id: null,
			status: "failed",
			error: errorMessage(o.error),
			mime_type: null,
			size_bytes: 0,
			chunk_count: null,
			fetcher: "local",
			source_sha256: "",
		};
	});

	// Single FTS rebuild for the whole batch — replaces N per-entry rebuilds
	// in the prior implementation. Skip when nothing was newly persisted.
	if (anyOk) {
		await rebuildFts(ctx.db);
	}

	return summarize(results);
}

/**
 * Per-file persist payload. All inputs are precomputed by the worker; this
 * helper just executes the transactional DB writes.
 */
interface PersistOneParams {
	logicalPath: string;
	sourceType: SourceType;
	sourcePath: string | null;
	sourceMtimeMs: number | null;
	sourceSha: string;
	blobSha: string | null;
	mime: string;
	bytes: Uint8Array | null;
	markdown: string;
	description: string;
	chunks: { index: number; content: string }[];
	searchTexts: string[];
	embeddings: number[][];
	fetcher: FetcherKind;
	downloader: string | null;
	downloaderArgs: Record<string, unknown> | null;
	refreshSec: number | null;
	changeNote: string | null;
}

/**
 * Write blob + new (logical_path, version_id) row + its chunks under a
 * single DuckDB transaction. ROLLBACK on failure keeps the row+chunks pair
 * atomic; one COMMIT replaces ~N+2 autocommitted round-trips.
 */
async function persistOne(ctx: AppContext, p: PersistOneParams): Promise<string> {
	const versionId = millisIso(Date.now());
	const contentSha = sha256Hex(new TextEncoder().encode(p.markdown));
	await ctx.db.exec("BEGIN TRANSACTION");
	try {
		if (p.bytes) {
			await upsertBlob(ctx.db, {
				sha256: p.sourceSha,
				mime_type: p.mime,
				size_bytes: p.bytes.byteLength,
				bytes: p.bytes,
			});
		}
		await insertVersion(ctx.db, {
			logical_path: p.logicalPath,
			version_id: versionId,
			source_type: p.sourceType,
			source_path: p.sourcePath,
			source_mtime_ms: p.sourceMtimeMs,
			source_sha256: p.sourceSha,
			blob_sha256: p.blobSha,
			content_sha256: contentSha,
			content: p.markdown,
			description: p.description,
			mime_type: p.mime,
			size_bytes: p.bytes?.byteLength ?? new TextEncoder().encode(p.markdown).byteLength,
			fetcher: p.fetcher,
			downloader: p.downloader,
			downloader_args: p.downloaderArgs,
			refresh_frequency_sec: p.refreshSec,
			refreshed_at: new Date().toISOString(),
			last_refresh_status: "ok",
			change_note: p.changeNote,
		});
		await insertChunksForVersion(
			ctx.db,
			p.logicalPath,
			versionId,
			p.chunks.map((c, i) => ({
				chunk_index: c.index,
				chunk_content: c.content,
				search_text: p.searchTexts[i] ?? buildSearchText(p.logicalPath, p.description, c.content),
				embedding: p.embeddings[i] ?? new Array(p.embeddings[0]?.length ?? 0).fill(0),
			})),
		);
		await ctx.db.exec("COMMIT");
	} catch (err) {
		await ctx.db.exec("ROLLBACK").catch(() => {
			// Best effort — if ROLLBACK itself fails (already aborted, lock
			// dropped, etc.) we still want the original error to surface.
		});
		throw err;
	}
	return versionId;
}

interface PipelineParams {
	logicalPath: string;
	bytes: Uint8Array;
	mime: string;
	source: string;
	sourceType: SourceType;
	sourcePath: string | null;
	sourceMtimeMs: number | null;
	sourceSha: string;
	fetcher: FetcherKind;
	downloader: string | null;
	downloaderArgs: Record<string, unknown> | null;
	refreshSec: number | null;
	changeNote: string | null;
}

/**
 * Run the bytes-in / version-out pipeline: store the blob, convert to
 * markdown, describe, chunk, embed, and write a new files row + chunks
 * rows under a fresh version_id. Returns the version_id so callers can
 * report it back. The optional `onEmbedProgress` is forwarded to the
 * embedder so callers can drive a spinner during the slow phase.
 */
async function pipelineForBytes(
	ctx: AppContext,
	p: PipelineParams,
	onPhase?: (sublabel: string) => void,
): Promise<{ versionId: string; chunkCount: number }> {
	onPhase?.("storing blob");
	await upsertBlob(ctx.db, {
		sha256: p.sourceSha,
		mime_type: p.mime,
		size_bytes: p.bytes.byteLength,
		bytes: p.bytes,
	});

	onPhase?.("converting");
	const conversion = await convert(p.bytes, p.mime, p.source, ctx.config.llm, ctx.config.converters);
	const markdown = conversion.markdown;
	const contentSha = sha256Hex(new TextEncoder().encode(markdown));

	return persistVersion(
		ctx,
		{
			logicalPath: p.logicalPath,
			sourceType: p.sourceType,
			sourcePath: p.sourcePath,
			sourceMtimeMs: p.sourceMtimeMs,
			sourceSha: p.sourceSha,
			blobSha: p.sourceSha,
			mime: p.mime,
			bytes: p.bytes,
			markdown,
			contentSha,
			fetcher: p.fetcher,
			downloader: p.downloader,
			downloaderArgs: p.downloaderArgs,
			refreshSec: p.refreshSec,
			changeNote: p.changeNote,
		},
		onPhase,
	);
}

interface PersistParams {
	logicalPath: string;
	sourceType: SourceType;
	sourcePath: string | null;
	sourceMtimeMs: number | null;
	sourceSha: string;
	blobSha: string | null;
	mime: string;
	bytes: Uint8Array | null;
	markdown: string;
	contentSha?: string;
	fetcher: FetcherKind;
	downloader: string | null;
	downloaderArgs: Record<string, unknown> | null;
	refreshSec: number | null;
	changeNote: string | null;
}

/**
 * Insert a new (logical_path, version_id) row plus its chunks. Description
 * is generated on every ingest (LLM with deterministic fallback). The
 * embedded text per chunk is `<path>\n<description>\n\n<body>`, stored
 * verbatim as `chunks.search_text` and later FTS-indexed.
 */
async function persistVersion(
	ctx: AppContext,
	p: PersistParams,
	onPhase?: (sublabel: string) => void,
): Promise<{ versionId: string; chunkCount: number }> {
	onPhase?.("describing");
	const description = await describe(p.logicalPath, p.mime, p.markdown, ctx.config.llm);
	onPhase?.("chunking");
	const chunks = chunkDeterministic(p.markdown, ctx.config.chunker);
	const searchTexts = chunks.map((c) => buildSearchText(p.logicalPath, description, c.content));
	let embeddings: number[][];
	try {
		embeddings = await embed(searchTexts, ctx.config.embedding_model, {
			onProgress: (done, total) => onPhase?.(`embedding ${done}/${total}`),
		});
	} catch (err) {
		throw asHelpful(
			err,
			`while embedding chunks for ${p.logicalPath}`,
			"Run `bun run prebuild` to apply the transformers WASM patch, or set a different config.embedding_model.",
		);
	}

	onPhase?.("persisting");
	const versionId = millisIso(Date.now());
	const contentSha = p.contentSha ?? sha256Hex(new TextEncoder().encode(p.markdown));
	await ctx.db.exec("BEGIN TRANSACTION");
	try {
		await insertVersion(ctx.db, {
			logical_path: p.logicalPath,
			version_id: versionId,
			source_type: p.sourceType,
			source_path: p.sourcePath,
			source_mtime_ms: p.sourceMtimeMs,
			source_sha256: p.sourceSha,
			blob_sha256: p.blobSha,
			content_sha256: contentSha,
			content: p.markdown,
			description,
			mime_type: p.mime,
			size_bytes: p.bytes?.byteLength ?? new TextEncoder().encode(p.markdown).byteLength,
			fetcher: p.fetcher,
			downloader: p.downloader,
			downloader_args: p.downloaderArgs,
			refresh_frequency_sec: p.refreshSec,
			refreshed_at: new Date().toISOString(),
			last_refresh_status: "ok",
			change_note: p.changeNote,
		});

		await insertChunksForVersion(
			ctx.db,
			p.logicalPath,
			versionId,
			chunks.map((c, i) => ({
				chunk_index: c.index,
				chunk_content: c.content,
				search_text: searchTexts[i] ?? buildSearchText(p.logicalPath, description, c.content),
				embedding: embeddings[i] ?? new Array(embeddings[0]?.length ?? 0).fill(0),
			})),
		);
		await ctx.db.exec("COMMIT");
	} catch (err) {
		await ctx.db.exec("ROLLBACK").catch(() => {});
		throw err;
	}
	onPhase?.("indexing");
	await rebuildFts(ctx.db);
	return { versionId, chunkCount: chunks.length };
}

/**
 * Pick the logical path for a single matched entry.
 *
 * - Default (no explicit logical_path): use the entry's absolute filesystem
 *   path with `\` normalized to `/` and the leading `/` stripped. This
 *   keeps `~/projA/README.md` and `~/projB/README.md` from colliding under
 *   a shared `README.md`. Two adds of the same absolute path produce the
 *   same logical_path, so the second add correctly creates a new version.
 * - Single-source with explicit logical_path: use it verbatim.
 * - Multi-entry (directory/glob) with explicit logical_path: treat as a
 *   prefix and append each entry's path relative to the walk base.
 */
export function pickLogicalPath(explicit: string | undefined, entry: ResolvedLocalEntry, isMulti: boolean): string {
	if (!explicit) return normalizeAbs(entry.absPath);
	if (!isMulti) return explicit;
	const prefix = explicit.endsWith("/") ? explicit.slice(0, -1) : explicit;
	return `${prefix}/${entry.relPathFromBase.replaceAll("\\", "/")}`;
}

/**
 * Normalize an absolute filesystem path into a logical_path:
 * `\` → `/`, leading `/` stripped. Drive letters (Windows `C:`) are kept
 * as the first path segment.
 */
export function normalizeAbs(absPath: string): string {
	return absPath.replaceAll("\\", "/").replace(/^\/+/, "");
}

/**
 * Default logical path for an ingested URL: `remotes/{host}/{pathname}`
 * with slashes preserved so two projects on the same host (e.g.,
 * github.com) don't collide. Query string and fragment are dropped from
 * the logical_path for stable identity — the full URL is still preserved
 * on the row in `source_path` and used for refresh.
 */
export function defaultLogicalForUrl(url: string): string {
	try {
		const u = new URL(url);
		const tail = u.pathname.replace(/^\/+/, "").replace(/\/+$/, "") || "index";
		return `remotes/${u.hostname}/${tail}`;
	} catch {
		return `remotes/${url.replace(/[^a-z0-9.-]/gi, "_")}`;
	}
}

function defaultInlinePath(): string {
	return `inline/${new Date().toISOString().replace(/[:.]/g, "-")}.md`;
}

/**
 * Convert a duration string (`5m`, `1h`, `24h`, `7d`) to seconds. Returns
 * null when the input is undefined / blank, throws a HelpfulError on
 * malformed input.
 */
export function parseDuration(input: string | null | undefined): number | null {
	if (!input?.trim()) return null;
	const m = input.trim().match(/^(\d+)([smhd])$/i);
	if (!m) {
		throw new HelpfulError({
			kind: "input_error",
			message: `invalid duration: ${input}`,
			hint: `Use forms like 5m, 1h, 24h, 7d.`,
		});
	}
	const n = Number(m[1]);
	const unit = m[2]?.toLowerCase() ?? "s";
	const multiplier = unit === "s" ? 1 : unit === "m" ? 60 : unit === "h" ? 3600 : 86400;
	return n * multiplier;
}

/** Roll a list of per-entry results into the top-level summary shape. */
function summarize(entries: IngestEntryResult[]): IngestResult {
	let ok = 0;
	let unchanged = 0;
	let failed = 0;
	for (const e of entries) {
		if (e.status === "ok") ok += 1;
		else if (e.status === "unchanged") unchanged += 1;
		else failed += 1;
	}
	return { ingested: entries, total: entries.length, ok, unchanged, failed };
}

function errorMessage(err: unknown): string {
	if (err instanceof HelpfulError) return `${err.message} — ${err.hint}`;
	if (err instanceof Error) return err.message;
	return String(err);
}

export { getCurrent };
