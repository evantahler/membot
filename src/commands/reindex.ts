import type { Command } from "commander";
import { buildContext, closeContext } from "../context.ts";
import { rebuildFts } from "../db/chunks.ts";
import { logger } from "../output/logger.ts";

/**
 * `membot reindex`
 *
 * Rebuild the FTS index over `current_chunks`. Useful after manually
 * editing the DB or upgrading after a schema change. Does NOT re-embed —
 * embeddings are durable and are managed by the ingest/refresh pipelines.
 */
export function registerReindexCommand(program: Command): void {
	program
		.command("reindex")
		.description("Rebuild the FTS keyword index over current chunks")
		.action(async () => {
			const ctx = await buildContext({});
			try {
				const result = await rebuildFts(ctx.db);
				switch (result.kind) {
					case "rebuilt":
						logger.info(`reindex: FTS index rebuilt over ${result.chunk_count} chunks`);
						console.log(JSON.stringify({ ok: true, chunk_count: result.chunk_count }));
						break;
					case "no_chunks":
						logger.info(
							"reindex: no chunks to index — run `membot add <path>` to ingest content first",
						);
						console.log(JSON.stringify({ ok: true, chunk_count: 0 }));
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
						logger.warn(
							`reindex: FTS rebuild failed${result.cause ? ` (${result.cause})` : ""}`,
						);
						console.log(
							JSON.stringify({ ok: false, reason: "rebuild_failed", cause: result.cause }),
						);
						break;
				}
			} finally {
				await closeContext(ctx);
			}
		});
}
