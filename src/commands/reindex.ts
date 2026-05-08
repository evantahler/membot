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
				const ok = await rebuildFts(ctx.db);
				if (ok) logger.info("reindex: FTS index rebuilt over current_chunks");
				else logger.warn("reindex: FTS extension not available or no chunks to index");
				console.log(JSON.stringify({ ok }));
			} finally {
				await closeContext(ctx);
			}
		});
}
