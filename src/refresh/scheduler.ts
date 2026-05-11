import { type AppContext, resolveEmbeddingWorkers } from "../context.ts";
import { listDueRefreshes } from "../db/files.ts";
import { withEmbedderPool } from "../ingest/embedder-pool.ts";
import { logger } from "../output/logger.ts";
import { type RefreshOutcome, refreshOne } from "./runner.ts";

/**
 * One scheduler tick: refresh every row whose `refresh_frequency_sec` has
 * elapsed since `refreshed_at`. Errors on individual rows are logged and
 * the loop continues so one bad source doesn't halt the daemon.
 *
 * The embedder worker pool is per-tick: spun up only if there are due rows,
 * torn down before the tick returns. The daemon never holds idle workers
 * between ticks (which can be minutes apart).
 */
export async function runDueRefreshes(ctx: AppContext): Promise<RefreshOutcome[]> {
	const due = await listDueRefreshes(ctx.db);
	if (due.length === 0) {
		logger.event("info", "daemon: tick (0 due)", { event: "daemon.tick", due_count: 0, refreshed_count: 0 });
		return [];
	}
	logger.event("info", `daemon: tick start (${due.length} due)`, {
		event: "daemon.tick.start",
		due_count: due.length,
	});
	const workers = resolveEmbeddingWorkers(ctx.config.embedding.workers);
	return withEmbedderPool(workers, ctx.config.embedding_model, async () => {
		const out: RefreshOutcome[] = [];
		let refreshed = 0;
		for (const row of due) {
			try {
				const r = await refreshOne(ctx, row.logical_path);
				out.push(r);
				if (r.status === "ok") {
					refreshed += 1;
					logger.event("info", `refresh: ${row.logical_path} → new version ${r.new_version_id}`, {
						event: "daemon.refresh.ok",
						logical_path: row.logical_path,
						new_version_id: r.new_version_id,
					});
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				logger.event("warn", `refresh: ${row.logical_path} failed (${msg})`, {
					event: "daemon.refresh.err",
					logical_path: row.logical_path,
					error_message: msg,
				});
				out.push({ logical_path: row.logical_path, status: "failed", error: msg });
			}
		}
		logger.event("info", `daemon: tick done (${refreshed}/${due.length} refreshed)`, {
			event: "daemon.tick.done",
			due_count: due.length,
			refreshed_count: refreshed,
		});
		return out;
	});
}

/**
 * Long-running daemon loop. Calls `runDueRefreshes` every `tick_interval_sec`
 * (from config). Returns a stop function the caller can use to terminate
 * the daemon (e.g. on SIGINT).
 */
export function startDaemon(ctx: AppContext, tickSec: number): () => void {
	const intervalMs = Math.max(1, tickSec) * 1000;
	let stopped = false;

	const loop = async () => {
		if (stopped) return;
		try {
			await runDueRefreshes(ctx);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			logger.event("warn", `daemon: tick failed (${msg})`, {
				event: "daemon.tick.failed",
				error_message: msg,
			});
		} finally {
			// Drop the DuckDB lock between ticks so the CLI / MCP server can
			// run while the daemon is idle. Next tick reopens transparently.
			try {
				await ctx.db.release();
			} catch {
				// best effort
			}
		}
		if (!stopped) setTimeout(loop, intervalMs);
	};

	logger.event("info", `daemon: started, tick interval ${tickSec}s`, {
		event: "daemon.started",
		tick_interval_sec: tickSec,
	});
	setTimeout(loop, intervalMs);

	return () => {
		stopped = true;
		logger.event("info", "daemon: stopping", { event: "daemon.stopping" });
	};
}
