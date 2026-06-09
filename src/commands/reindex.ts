import type { Command } from "commander";
import { EMBEDDING_REVISION } from "../constants.ts";
import type { AppContext } from "../context.ts";
import { buildContext, closeContext, resolveEmbeddingWorkers } from "../context.ts";
import { deleteChunksForVersion, insertChunksForVersion, rebuildChunksTable, rebuildFts } from "../db/chunks.ts";
import { META_EMBEDDING_REVISION, setMeta } from "../db/meta.ts";
import { asHelpful } from "../errors.ts";
import { chunkDeterministic } from "../ingest/chunker.ts";
import { AsyncMutex, pMap } from "../ingest/concurrency.ts";
import { embed } from "../ingest/embedder.ts";
import { withEmbedderPool } from "../ingest/embedder-pool.ts";
import { buildSearchText } from "../ingest/search-text.ts";
import { logger } from "../output/logger.ts";

/**
 * `membot reindex [--embeddings]`
 *
 * Default: rebuild the FTS index over `current_chunks`. Useful after manually
 * editing the DB or upgrading after a schema change.
 *
 * `--embeddings`: additionally re-chunk and re-embed EVERY non-tombstoned
 * version from its stored `files.content`, then bump the store's
 * `embedding_revision` to the current value. This is the upgrade path after
 * a change to the embedding scheme (pooling mode, chunk sizing, search_text
 * shape) — old vectors are incomparable with new query vectors, so search
 * warns until this runs. Content, descriptions, and version history are
 * untouched; only the derived chunk rows are regenerated.
 *
 * `--recovery`: before anything else, rebuild the `chunks` table to regenerate
 * its primary-key index. Use this if a plain `reindex --embeddings` crashes
 * with a DuckDB `Failed to delete all rows from index` error (which surfaces
 * as a hard `panic: A C++ exception occurred` / SIGTRAP): the store's chunk
 * index has drifted out of sync with the table, and the per-version DELETE in
 * the re-embed loop trips it. The rebuild preserves every chunk row exactly.
 */
export function registerReindexCommand(program: Command): void {
	program
		.command("reindex")
		.description("Rebuild the FTS keyword index over current chunks")
		.option(
			"--embeddings",
			"Also re-chunk + re-embed every version from stored content (run after upgrading across an embedding-revision bump)",
		)
		.option(
			"--recovery",
			"Rebuild the chunks table first to repair a corrupted primary-key index (use if reindex --embeddings crashes with a DuckDB index error)",
		)
		.action(async (opts: { embeddings?: boolean; recovery?: boolean }) => {
			const ctx = await buildContext({});
			try {
				if (opts.recovery) {
					const { rows } = await rebuildChunksTable(ctx.db);
					logger.info(`reindex: chunks table rebuilt (${rows} chunks) — primary-key index regenerated`);
				}
				if (opts.embeddings) {
					await reembedAllVersions(ctx);
				}
				const result = await rebuildFts(ctx.db);
				switch (result.kind) {
					case "rebuilt":
						logger.info(`reindex: FTS index rebuilt over ${result.chunk_count} chunks`);
						console.log(
							JSON.stringify({
								ok: true,
								chunk_count: result.chunk_count,
								embeddings: !!opts.embeddings,
								recovery: !!opts.recovery,
							}),
						);
						break;
					case "no_chunks":
						logger.info("reindex: no chunks to index — run `membot add <path>` to ingest content first");
						console.log(
							JSON.stringify({ ok: true, chunk_count: 0, embeddings: !!opts.embeddings, recovery: !!opts.recovery }),
						);
						break;
					case "extension_unavailable":
						logger.warn(
							`reindex: FTS extension unavailable — search will degrade to semantic-only${
								result.cause ? ` (${result.cause})` : ""
							}`,
						);
						console.log(
							JSON.stringify({
								ok: false,
								reason: "fts_extension_unavailable",
								cause: result.cause,
							}),
						);
						break;
					case "rebuild_failed":
						logger.warn(`reindex: FTS rebuild failed${result.cause ? ` (${result.cause})` : ""}`);
						console.log(JSON.stringify({ ok: false, reason: "rebuild_failed", cause: result.cause }));
						break;
				}
			} finally {
				await closeContext(ctx);
			}
		});
}

/**
 * Re-chunk + re-embed every non-tombstoned version that has content, writing
 * the regenerated chunk rows in place of the old ones (one transaction per
 * version, so a crash mid-run leaves every version either fully old or fully
 * new). Descriptions are reused from the row — no LLM calls. Embedding fans
 * out across the per-command worker pool; the DB writes are serialized
 * through one mutex because all workers share a single connection. Bumps
 * `meta.embedding_revision` to the current value once every version is done.
 *
 * Exported for tests; production entry is `membot reindex --embeddings`.
 */
export async function reembedAllVersions(ctx: AppContext): Promise<{ versions: number; chunks: number }> {
	const versions = await ctx.db.queryAll<{ logical_path: string; version_id: string }>(
		`SELECT logical_path, CAST(version_id AS VARCHAR) AS version_id
		 FROM files
		 WHERE tombstone = FALSE AND content IS NOT NULL
		 ORDER BY logical_path, version_id`,
	);
	if (versions.length === 0) {
		logger.info("reindex: no versions with content to re-embed");
		await setMeta(ctx.db, META_EMBEDDING_REVISION, String(EMBEDDING_REVISION));
		return { versions: 0, chunks: 0 };
	}

	const workers = resolveEmbeddingWorkers(ctx.config.embedding.workers);
	logger.info(`reindex: re-embedding ${versions.length} versions (workers=${workers})`);
	ctx.progress.start(versions.length, "re-embedding");

	let totalChunks = 0;
	const persistMutex = new AsyncMutex();
	const outcomes = await withEmbedderPool(workers, ctx.config.embedding_model, async () => {
		return pMap(versions, Math.max(1, Math.min(workers, versions.length)), async (v) => {
			const row = await ctx.db.queryGet<{ description: string | null; content: string }>(
				`SELECT description, content FROM files
				 WHERE logical_path = ?1 AND version_id = CAST(?2 AS TIMESTAMP)`,
				v.logical_path,
				v.version_id,
			);
			if (!row?.content) {
				ctx.progress.tick(v.logical_path);
				return;
			}
			const chunks = chunkDeterministic(row.content, ctx.config.chunker);
			const searchTexts = chunks.map((c) => buildSearchText(v.logical_path, row.description, c.content, c.context));
			let embeddings: number[][];
			try {
				embeddings = await embed(searchTexts, ctx.config.embedding_model);
			} catch (err) {
				throw asHelpful(
					err,
					`while re-embedding ${v.logical_path}@${v.version_id}`,
					"Run `bun run prebuild` to apply the transformers WASM patch, or set a different config.embedding_model.",
				);
			}
			await persistMutex.lock(async () => {
				await ctx.db.exec("BEGIN TRANSACTION");
				try {
					await deleteChunksForVersion(ctx.db, v.logical_path, v.version_id);
					await insertChunksForVersion(
						ctx.db,
						v.logical_path,
						v.version_id,
						chunks.map((c, i) => ({
							chunk_index: c.index,
							chunk_content: c.content,
							search_text: searchTexts[i] ?? buildSearchText(v.logical_path, row.description, c.content, c.context),
							embedding: embeddings[i] ?? new Array(embeddings[0]?.length ?? 0).fill(0),
							context: c.context ?? null,
						})),
					);
					await ctx.db.exec("COMMIT");
				} catch (err) {
					await ctx.db.exec("ROLLBACK").catch(() => {
						// Best effort — surface the original error.
					});
					throw err;
				}
			});
			totalChunks += chunks.length;
			ctx.progress.tick(v.logical_path);
		});
	});

	const failures = outcomes.filter((o) => !o.ok);
	if (failures.length > 0) {
		for (const f of failures) {
			logger.warn(`reindex: ${f.ok ? "" : f.error instanceof Error ? f.error.message : String(f.error)}`);
		}
		ctx.progress.done(`re-embedded ${versions.length - failures.length}/${versions.length} versions`);
		// Leave the revision untouched so the stale-embeddings warning keeps
		// firing — a partial re-embed is exactly the mixed-vector state the
		// revision exists to flag. Re-running the command is safe.
		logger.warn(
			`reindex: ${failures.length} versions failed — embedding revision NOT bumped; re-run \`membot reindex --embeddings\``,
		);
		return { versions: versions.length - failures.length, chunks: totalChunks };
	}

	await setMeta(ctx.db, META_EMBEDDING_REVISION, String(EMBEDDING_REVISION));
	ctx.progress.done(`re-embedded ${versions.length} versions (${totalChunks} chunks)`);
	logger.info(`reindex: embedding revision is now ${EMBEDDING_REVISION}`);
	return { versions: versions.length, chunks: totalChunks };
}
