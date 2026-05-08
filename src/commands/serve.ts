import type { Command } from "commander";
import { buildContext, closeContext } from "../context.ts";
import { startStdioServer } from "../mcp/server.ts";
import { logger } from "../output/logger.ts";
import { startDaemon } from "../refresh/scheduler.ts";

/**
 * `membot serve [--http <port>] [--watch] [--tick <sec>]`
 *
 * Start the MCP server in stdio mode (default) or HTTP streamable mode
 * (when `--http <port>` is given). Optionally also start the refresh
 * daemon (`--watch`) which ticks every `--tick` seconds and refreshes
 * any rows whose `refresh_frequency_sec` has elapsed.
 */
export function registerServeCommand(program: Command): void {
	program
		.command("serve")
		.description("Run the MCP server (stdio default, --http for streamable HTTP) and optionally the refresh daemon")
		.option("--http <port>", "expose MCP over HTTP on this port instead of stdio")
		.option("--watch", "also run the refresh daemon (auto-refresh due rows)")
		.option("--tick <sec>", "daemon tick interval in seconds (default 60)")
		.action(async (options: { http?: string; watch?: boolean; tick?: string }) => {
			const httpPort = options.http ? Number(options.http) : null;
			let stopServer: (() => Promise<void>) | null = null;
			let stopDaemon: (() => void) | null = null;

			const onShutdown = async () => {
				if (stopDaemon) stopDaemon();
				if (stopServer) await stopServer();
			};
			process.on("SIGINT", () => {
				logger.info("shutting down...");
				onShutdown().finally(() => process.exit(0));
			});
			process.on("SIGTERM", () => {
				onShutdown().finally(() => process.exit(0));
			});

			if (httpPort && !Number.isFinite(httpPort)) {
				logger.error(`invalid --http port: ${options.http}`);
				process.exit(2);
			}

			if (options.watch) {
				const ctx = await buildContext({});
				const tickSec = options.tick ? Number(options.tick) : ctx.config.daemon.tick_interval_sec;
				stopDaemon = startDaemon(ctx, Number.isFinite(tickSec) && tickSec > 0 ? tickSec : 60);
				process.on("beforeExit", () => closeContext(ctx));
			}

			if (httpPort) {
				const { startHttpServer } = await import("../mcp/server.ts");
				stopServer = await startHttpServer(httpPort);
			} else {
				stopServer = await startStdioServer();
			}
		});
}
