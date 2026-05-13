import type { AppContext } from "../context.ts";
import { upsertBlob } from "../db/blobs.ts";
import { insertChunksForVersion, rebuildFts } from "../db/chunks.ts";
import { type FetcherKind, getCurrent, insertVersion, millisIso, updateRefreshStatus } from "../db/files.ts";
import { HelpfulError } from "../errors.ts";
import { shouldPersistBlobBytes } from "../ingest/blob-policy.ts";
import { chunkDeterministic } from "../ingest/chunker.ts";
import { convert } from "../ingest/converter/index.ts";
import { describe } from "../ingest/describer.ts";
import { embed } from "../ingest/embedder.ts";
import { mimeFromPath, readLocalFile, sha256Hex } from "../ingest/local-reader.ts";
import { buildSearchText } from "../ingest/search-text.ts";
import { findSourceByName, findSourceForInput } from "../ingest/sources/registry.ts";
import type { PluginCtx, SourcePlugin } from "../ingest/sources/types.ts";
import { logger } from "../output/logger.ts";

export interface RefreshOutcome {
	logical_path: string;
	status: "ok" | "unchanged" | "failed";
	new_version_id?: string;
	error?: string;
}

/**
 * Refresh one logical_path. Re-reads its source (local stat+sha or
 * remote via the persisted downloader name + the original URL), and
 * creates a new version only if the source bytes changed. Always
 * updates `refreshed_at` and `last_refresh_status` on the row. Returns
 * a per-path outcome — never throws unless the path doesn't exist. The
 * optional `onPhase` callback is forwarded to the embedder so
 * interactive callers (e.g. the `refresh` operation) can drive a
 * spinner during the slow phase.
 */
export async function refreshOne(
	ctx: AppContext,
	logicalPath: string,
	force = false,
	onPhase?: (sublabel: string) => void,
): Promise<RefreshOutcome> {
	const cur = await getCurrent(ctx.db, logicalPath);
	if (!cur) {
		throw new HelpfulError({
			kind: "not_found",
			message: `no current version for ${logicalPath}`,
			hint: `Run \`membot ls\` to see available paths, or ingest with \`membot add\`.`,
		});
	}

	if (cur.source_type === "inline") {
		return { logical_path: logicalPath, status: "unchanged" };
	}

	try {
		if (cur.source_type === "local") {
			return await refreshLocal(ctx, cur, force, onPhase);
		}
		if (cur.source_type === "remote") {
			return await refreshRemote(ctx, cur, force, onPhase);
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		await updateRefreshStatus(ctx.db, logicalPath, cur.version_id, {
			refreshed_at: new Date().toISOString(),
			last_refresh_status: `failed:${message}`,
		});
		return { logical_path: logicalPath, status: "failed", error: message };
	}
	return { logical_path: logicalPath, status: "unchanged" };
}

interface CurrentRow {
	logical_path: string;
	version_id: string;
	source_type: string;
	source_path: string | null;
	source_mtime_ms: number | null;
	source_sha256: string | null;
	mime_type: string | null;
	fetcher: string | null;
	downloader: string | null;
	downloader_args: Record<string, unknown> | null;
	refresh_frequency_sec: number | null;
}

/** Local-file refresh: stat-then-sha gate before re-running the pipeline. */
async function refreshLocal(
	ctx: AppContext,
	cur: CurrentRow,
	force: boolean,
	onPhase?: (sublabel: string) => void,
): Promise<RefreshOutcome> {
	if (!cur.source_path) {
		throw new HelpfulError({
			kind: "input_error",
			message: `local row ${cur.logical_path} has no source_path`,
			hint: "This row likely came from an inline write. Re-ingest with `membot add` if you want refreshing.",
		});
	}
	const local = await readLocalFile(cur.source_path);

	if (!force && cur.source_sha256 === local.sha256) {
		await updateRefreshStatus(ctx.db, cur.logical_path, cur.version_id, {
			refreshed_at: new Date().toISOString(),
			last_refresh_status: "unchanged",
		});
		return { logical_path: cur.logical_path, status: "unchanged" };
	}

	const versionId = await runPipelineForRefresh(
		ctx,
		{
			logicalPath: cur.logical_path,
			bytes: local.bytes,
			mime: local.mimeType,
			source: cur.source_path,
			sourceType: "local",
			sourcePath: cur.source_path,
			sourceMtimeMs: local.mtimeMs,
			sourceSha: local.sha256,
			fetcher: "local",
			downloader: null,
			downloaderArgs: null,
			refreshSec: cur.refresh_frequency_sec,
		},
		onPhase,
	);
	return { logical_path: cur.logical_path, status: "ok", new_version_id: versionId };
}

/**
 * Remote refresh: replay the persisted plugin against the original
 * source. Each plugin's `fetch` is deterministic (no LLM, no agent loop),
 * so a row with `downloader='google-docs'` always re-runs the Google
 * Docs plugin; rows from older membot versions whose `downloader` is
 * NULL fall back to URL-based dispatch.
 *
 * Apple-notes-shaped rows (markdown directly, no blob) work through the
 * same code path: the plugin's `fetch` returns `mimeType='text/markdown'`
 * with bytes that are the markdown body. `runPipelineForRefresh` notices
 * `text/markdown` and skips the blob upsert + bytes-to-markdown conversion.
 */
async function refreshRemote(
	ctx: AppContext,
	cur: CurrentRow,
	force: boolean,
	onPhase?: (sublabel: string) => void,
): Promise<RefreshOutcome> {
	if (!cur.source_path) {
		throw new HelpfulError({
			kind: "input_error",
			message: `remote row ${cur.logical_path} has no source_path`,
			hint: "Inspect with `membot info` and consider re-ingesting.",
		});
	}
	const plugin = pickPluginForRefresh(cur);
	const entry = plugin.rehydrateEntry(cur.source_path, (cur.downloader_args ?? {}) as Record<string, unknown>);
	const pluginCtx: PluginCtx = {
		logger,
		config: ctx.config,
		onProgress: onPhase,
	};
	// Cheap pre-fetch gate (apple-notes mtime). When it fires we
	// short-circuit before any IO; the row's refresh status flips to
	// `unchanged` without touching content.
	if (!force && plugin.probeUnchanged) {
		if (
			plugin.probeUnchanged(entry, {
				source_mtime_ms: cur.source_mtime_ms,
				source_sha256: cur.source_sha256,
			})
		) {
			await updateRefreshStatus(ctx.db, cur.logical_path, cur.version_id, {
				refreshed_at: new Date().toISOString(),
				last_refresh_status: "unchanged",
			});
			return { logical_path: cur.logical_path, status: "unchanged" };
		}
	}

	const fetcher = await plugin.openBatchFetcher(pluginCtx);
	let fetched: Awaited<ReturnType<typeof fetcher.fetch>>;
	try {
		fetched = await fetcher.fetch(entry, pluginCtx);
	} finally {
		await fetcher.close();
	}

	if (!force && cur.source_sha256 === fetched.sha256) {
		await updateRefreshStatus(ctx.db, cur.logical_path, cur.version_id, {
			refreshed_at: new Date().toISOString(),
			last_refresh_status: "unchanged",
		});
		return { logical_path: cur.logical_path, status: "unchanged" };
	}

	const versionId = await runPipelineForRefresh(
		ctx,
		{
			logicalPath: cur.logical_path,
			bytes: fetched.bytes,
			mime: fetched.mimeType,
			source: cur.source_path,
			sourceType: "remote",
			sourcePath: cur.source_path,
			sourceMtimeMs: entry.mtimeMs ?? null,
			sourceSha: fetched.sha256,
			fetcher: "downloader",
			downloader: fetched.downloader,
			downloaderArgs: fetched.downloaderArgs,
			refreshSec: cur.refresh_frequency_sec,
		},
		onPhase,
	);
	return { logical_path: cur.logical_path, status: "ok", new_version_id: versionId };
}

/**
 * Look up the plugin to refresh with. Prefers the persisted `downloader`
 * name (deterministic replay), falls back to URL match (handles rows
 * from older versions whose `downloader` is NULL or names a plugin no
 * longer registered).
 */
function pickPluginForRefresh(cur: CurrentRow): SourcePlugin {
	if (cur.downloader) {
		const named = findSourceByName(cur.downloader);
		if (named) return named;
	}
	if (cur.source_path) {
		const matched = findSourceForInput(cur.source_path);
		if (matched) return matched;
	}
	throw new HelpfulError({
		kind: "input_error",
		message: `no source plugin matches ${cur.source_path ?? "(missing source_path)"} (persisted downloader: ${cur.downloader ?? "null"})`,
		hint: "Re-ingest the row with `membot add` to pick a fresh plugin.",
	});
}

interface PipelineParams {
	logicalPath: string;
	bytes: Uint8Array;
	mime: string;
	source: string;
	sourceType: "local" | "remote";
	sourcePath: string | null;
	sourceMtimeMs: number | null;
	sourceSha: string;
	fetcher: FetcherKind;
	downloader: string | null;
	downloaderArgs: Record<string, unknown> | null;
	refreshSec: number | null;
}

/**
 * Re-run convert → describe → chunk → embed and write a fresh version
 * row. Mirrors `ingest.ts`'s pipeline; kept separate so refresh-specific
 * fields (`change_note='refresh: source updated'`) aren't accidentally
 * applied to first-time ingests.
 */
async function runPipelineForRefresh(
	ctx: AppContext,
	p: PipelineParams,
	onPhase?: (sublabel: string) => void,
): Promise<string> {
	// Plugins that produce markdown directly (linear, github, apple-notes)
	// arrive here with `mime='text/markdown'`. Skip the blob upsert + the
	// pass-through `convert()` round-trip for those — the bytes ARE the
	// markdown. Binary plugins (the Google ones) take the full path, with
	// the blob-policy gate applied so videos/oversized payloads keep their
	// metadata row but skip the byte persistence.
	const isMarkdownDirect = p.mime === "text/markdown";
	if (!isMarkdownDirect) {
		onPhase?.("storing blob");
		const policy = shouldPersistBlobBytes(p.mime, p.bytes.byteLength, ctx.config.blobs);
		await upsertBlob(ctx.db, {
			sha256: p.sourceSha,
			mime_type: p.mime,
			size_bytes: p.bytes.byteLength,
			bytes: policy.persist ? p.bytes : null,
		});
		if (!policy.persist) {
			ctx.logger.info(
				`refresh: skipping blob bytes for ${p.logicalPath} (${policy.reason === "mime" ? `mime '${p.mime}' matches blobs.skip_mime_types` : `size exceeds blobs.max_size_bytes`})`,
			);
		}
	}

	let markdown: string;
	if (isMarkdownDirect) {
		markdown = new TextDecoder().decode(p.bytes);
	} else {
		onPhase?.("converting");
		const conversion = await convert(p.bytes, p.mime, p.source, ctx.config.llm, ctx.config.converters);
		markdown = conversion.markdown;
	}
	onPhase?.("describing");
	const description = await describe(p.logicalPath, p.mime, markdown, ctx.config.llm);
	onPhase?.("chunking");
	const chunks = chunkDeterministic(markdown, ctx.config.chunker);
	const searchTexts = chunks.map((c) => buildSearchText(p.logicalPath, description, c.content));
	const embeddings = await embed(searchTexts, ctx.config.embedding_model, {
		onProgress: (done, total) => onPhase?.(`embedding ${done}/${total}`),
	});

	const versionId = millisIso(Date.now());
	const contentSha = sha256Hex(new TextEncoder().encode(markdown));
	await insertVersion(ctx.db, {
		logical_path: p.logicalPath,
		version_id: versionId,
		source_type: p.sourceType,
		source_path: p.sourcePath,
		source_mtime_ms: p.sourceMtimeMs,
		source_sha256: p.sourceSha,
		blob_sha256: isMarkdownDirect ? null : p.sourceSha,
		content_sha256: contentSha,
		content: markdown,
		description,
		mime_type: p.mime,
		size_bytes: p.bytes.byteLength,
		fetcher: p.fetcher,
		downloader: p.downloader,
		downloader_args: p.downloaderArgs,
		refresh_frequency_sec: p.refreshSec,
		refreshed_at: new Date().toISOString(),
		last_refresh_status: "ok",
		change_note: "refresh: source updated",
	});

	onPhase?.("persisting");

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

	onPhase?.("indexing");
	await rebuildFts(ctx.db);
	return versionId;
}

export { mimeFromPath };
