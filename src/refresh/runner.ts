import type { McpxClient } from "@evantahler/mcpx";
import type { AppContext } from "../context.ts";
import { upsertBlob } from "../db/blobs.ts";
import { insertChunksForVersion, rebuildFts } from "../db/chunks.ts";
import { getCurrent, insertVersion, millisIso, updateRefreshStatus } from "../db/files.ts";
import { HelpfulError } from "../errors.ts";
import { chunkDeterministic } from "../ingest/chunker.ts";
import { convert } from "../ingest/converter/index.ts";
import { describe } from "../ingest/describer.ts";
import { embed } from "../ingest/embedder.ts";
import { fetchRemote } from "../ingest/fetcher.ts";
import { mimeFromPath, readLocalFile, sha256Hex } from "../ingest/local-reader.ts";
import { buildSearchText } from "../ingest/search-text.ts";

export interface RefreshOutcome {
	logical_path: string;
	status: "ok" | "unchanged" | "failed";
	new_version_id?: string;
	error?: string;
}

/**
 * Refresh one logical_path. Re-reads its source (local stat+sha or remote
 * via the persisted mcpx invocation), and creates a new version only if
 * the source bytes changed. Always updates `refreshed_at` and
 * `last_refresh_status` on the row. Returns a per-path outcome — never
 * throws unless the path doesn't exist.
 */
export async function refreshOne(ctx: AppContext, logicalPath: string, force = false): Promise<RefreshOutcome> {
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
			return await refreshLocal(ctx, cur, force);
		}
		if (cur.source_type === "remote") {
			return await refreshRemote(ctx, cur, force);
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
	fetcher_server: string | null;
	fetcher_tool: string | null;
	fetcher_args: Record<string, unknown> | null;
	refresh_frequency_sec: number | null;
}

/** Local-file refresh: stat-then-sha gate before re-running the pipeline. */
async function refreshLocal(ctx: AppContext, cur: CurrentRow, force: boolean): Promise<RefreshOutcome> {
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

	const versionId = await runPipelineForRefresh(ctx, {
		logicalPath: cur.logical_path,
		bytes: local.bytes,
		mime: local.mimeType,
		source: cur.source_path,
		sourceType: "local",
		sourcePath: cur.source_path,
		sourceMtimeMs: local.mtimeMs,
		sourceSha: local.sha256,
		fetcher: "local",
		fetcherServer: null,
		fetcherTool: null,
		fetcherArgs: null,
		refreshSec: cur.refresh_frequency_sec,
	});
	return { logical_path: cur.logical_path, status: "ok", new_version_id: versionId };
}

/** Remote refresh: replay the persisted mcpx invocation, or plain HTTP. */
async function refreshRemote(ctx: AppContext, cur: CurrentRow, force: boolean): Promise<RefreshOutcome> {
	if (!cur.source_path) {
		throw new HelpfulError({
			kind: "input_error",
			message: `remote row ${cur.logical_path} has no source_path`,
			hint: "Inspect with `membot info` and consider re-ingesting.",
		});
	}
	const fetched = await replayFetch(cur, ctx.mcpx);

	if (!force && cur.source_sha256 === fetched.sha256) {
		await updateRefreshStatus(ctx.db, cur.logical_path, cur.version_id, {
			refreshed_at: new Date().toISOString(),
			last_refresh_status: "unchanged",
		});
		return { logical_path: cur.logical_path, status: "unchanged" };
	}

	const versionId = await runPipelineForRefresh(ctx, {
		logicalPath: cur.logical_path,
		bytes: fetched.bytes,
		mime: fetched.mimeType,
		source: cur.source_path,
		sourceType: "remote",
		sourcePath: cur.source_path,
		sourceMtimeMs: null,
		sourceSha: fetched.sha256,
		fetcher: cur.fetcher === "mcpx" ? "mcpx" : "http",
		fetcherServer: fetched.fetcherServer,
		fetcherTool: fetched.fetcherTool,
		fetcherArgs: fetched.fetcherArgs,
		refreshSec: cur.refresh_frequency_sec,
	});
	return { logical_path: cur.logical_path, status: "ok", new_version_id: versionId };
}

/**
 * Re-fetch a remote source. When the row recorded an mcpx invocation,
 * call it directly with the same args (no agent re-routing); otherwise
 * fall back to plain HTTP. The choice is deterministic — same row always
 * produces the same fetch path.
 */
async function replayFetch(
	cur: CurrentRow,
	mcpx: McpxClient | null,
): Promise<{
	bytes: Uint8Array;
	sha256: string;
	mimeType: string;
	fetcherServer: string | null;
	fetcherTool: string | null;
	fetcherArgs: Record<string, unknown> | null;
}> {
	if (cur.fetcher === "mcpx" && cur.fetcher_server && cur.fetcher_tool && mcpx) {
		const args = cur.fetcher_args ?? {};
		const result = await mcpx.exec(cur.fetcher_server, cur.fetcher_tool, args);
		const text = extractText(result);
		const bytes = new TextEncoder().encode(text);
		return {
			bytes,
			sha256: sha256Hex(bytes),
			mimeType: "text/markdown",
			fetcherServer: cur.fetcher_server,
			fetcherTool: cur.fetcher_tool,
			fetcherArgs: args,
		};
	}
	const r = await fetchRemote(cur.source_path ?? "", { hint: "http" });
	return {
		bytes: r.bytes,
		sha256: r.sha256,
		mimeType: r.mimeType,
		fetcherServer: null,
		fetcherTool: null,
		fetcherArgs: null,
	};
}

/** Pull a string out of whatever shape an mcpx tool happens to return. */
function extractText(result: unknown): string {
	if (typeof result === "string") return result;
	if (result && typeof result === "object") {
		const r = result as Record<string, unknown>;
		if (typeof r.text === "string") return r.text;
		if (typeof r.content === "string") return r.content;
		if (typeof r.markdown === "string") return r.markdown;
		if (Array.isArray(r.content)) {
			const out: string[] = [];
			for (const c of r.content) {
				if (c && typeof c === "object") {
					const inner = c as Record<string, unknown>;
					if (typeof inner.text === "string") out.push(inner.text);
				}
			}
			if (out.length > 0) return out.join("\n\n");
		}
	}
	try {
		return JSON.stringify(result);
	} catch {
		return "";
	}
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
	fetcher: "local" | "http" | "mcpx";
	fetcherServer: string | null;
	fetcherTool: string | null;
	fetcherArgs: Record<string, unknown> | null;
	refreshSec: number | null;
}

/**
 * Re-run convert → describe → chunk → embed and write a fresh version
 * row. Mirrors `ingest.ts`'s pipeline; kept separate so refresh-specific
 * fields (`change_note='refresh: source updated'`) aren't accidentally
 * applied to first-time ingests.
 */
async function runPipelineForRefresh(ctx: AppContext, p: PipelineParams): Promise<string> {
	await upsertBlob(ctx.db, {
		sha256: p.sourceSha,
		mime_type: p.mime,
		size_bytes: p.bytes.byteLength,
		bytes: p.bytes,
	});

	const conversion = await convert(p.bytes, p.mime, p.source, ctx.config.llm);
	const markdown = conversion.markdown;
	const description = await describe(p.logicalPath, p.mime, markdown, ctx.config.llm);
	const chunks = chunkDeterministic(markdown, ctx.config.chunker);
	const searchTexts = chunks.map((c) => buildSearchText(p.logicalPath, description, c.content));
	const embeddings = await embed(searchTexts, ctx.config.embedding_model);

	const versionId = millisIso(Date.now());
	const contentSha = sha256Hex(new TextEncoder().encode(markdown));
	await insertVersion(ctx.db, {
		logical_path: p.logicalPath,
		version_id: versionId,
		source_type: p.sourceType,
		source_path: p.sourcePath,
		source_mtime_ms: p.sourceMtimeMs,
		source_sha256: p.sourceSha,
		blob_sha256: p.sourceSha,
		content_sha256: contentSha,
		content: markdown,
		description,
		mime_type: p.mime,
		size_bytes: p.bytes.byteLength,
		fetcher: p.fetcher,
		fetcher_server: p.fetcherServer,
		fetcher_tool: p.fetcherTool,
		fetcher_args: p.fetcherArgs,
		refresh_frequency_sec: p.refreshSec,
		refreshed_at: new Date().toISOString(),
		last_refresh_status: "ok",
		change_note: "refresh: source updated",
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

	await rebuildFts(ctx.db);
	return versionId;
}

export { mimeFromPath };
