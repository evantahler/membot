import type { AppContext } from "../context.ts";
import { listDueRefreshes } from "../db/files.ts";
import { logger } from "../output/logger.ts";
import { type RefreshOutcome, refreshOne } from "./runner.ts";

/**
 * One scheduler tick: refresh every row whose `refresh_frequency_sec` has
 * elapsed since `refreshed_at`. Errors on individual rows are logged and
 * the loop continues so one bad source doesn't halt the daemon.
 */
export async function runDueRefreshes(ctx: AppContext): Promise<RefreshOutcome[]> {
	const due = await listDueRefreshes(ctx.db);
	const out: RefreshOutcome[] = [];
	for (const row of due) {
		try {
			const r = await refreshOne(ctx, row.logical_path);
			out.push(r);
			if (r.status === "ok") logger.info(`refresh: ${row.logical_path} → new version ${r.new_version_id}`);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			logger.warn(`refresh: ${row.logical_path} failed (${msg})`);
			out.push({ logical_path: row.logical_path, status: "failed", error: msg });
		}
	}
	return out;
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
			logger.warn(`daemon: tick failed (${err instanceof Error ? err.message : String(err)})`);
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

	logger.info(`daemon: started, tick interval ${tickSec}s`);
	setTimeout(loop, intervalMs);

	return () => {
		stopped = true;
		logger.info("daemon: stopping");
	};
}
