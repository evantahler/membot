import { cpus } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config/loader.ts";
import type { MembotConfig } from "./config/schemas.ts";
import { FILES } from "./constants.ts";
import { type DbConnection, openDb } from "./db/connection.ts";
import { logger } from "./output/logger.ts";
import type { Progress } from "./output/progress.ts";
import { createProgress } from "./output/progress.ts";
import { detectMode, setMode } from "./output/tty.ts";

export interface AppContext {
	config: MembotConfig;
	dataDir: string;
	configPath: string;
	db: DbConnection;
	logger: typeof logger;
	progress: Progress;
}

export interface BuildContextOptions {
	configFlag?: string;
	json?: boolean;
	verbose?: boolean;
	noColor?: boolean;
	noInteractive?: boolean;
}

/**
 * Resolve `config.embedding.workers` to a concrete worker count. Precedence:
 *   1. An explicit numeric value in the config wins (user opt-in).
 *   2. `MEMBOT_EMBEDDING_WORKERS` env var, if set to a positive integer.
 *      The test harness sets this to `1` so unit tests doing tiny writes
 *      don't pay the per-pool subprocess-spawn cost on slow CI runners.
 *   3. Otherwise `null`/missing → `max(1, cpus()-1)`. The minus-one leaves
 *      a core for the parent process (DB writes, IO, the spinner).
 */
export function resolveEmbeddingWorkers(configured: number | null | undefined): number {
	if (typeof configured === "number" && configured >= 1) return configured;
	const envOverride = process.env.MEMBOT_EMBEDDING_WORKERS;
	if (envOverride) {
		const n = Number(envOverride);
		if (Number.isFinite(n) && n >= 1) return Math.floor(n);
	}
	return Math.max(1, cpus().length - 1);
}

/**
 * Build the AppContext used by every operation handler. Initializes:
 *  - output mode (TTY/JSON/color detection — frozen for the rest of the run)
 *  - config (~/.membot/config.json with env overrides)
 *  - DuckDB connection (~/.membot/index.duckdb), running migrations on first open
 *
 * The embedder worker pool is NOT created here — it's per-command,
 * spawned by `withEmbedderPool()` at the top of bulk-embedding handlers
 * (`add`, `refresh`, `write`) and disposed before they return.
 */
export async function buildContext(options: BuildContextOptions = {}): Promise<AppContext> {
	setMode(detectMode({ json: options.json, verbose: options.verbose, noColor: options.noColor }));

	const { config, dataDir, configPath } = await loadConfig({ configFlag: options.configFlag });
	const dbPath = join(dataDir, FILES.INDEX_DUCKDB);
	const db = await openDb(dbPath, {
		maxAttempts: config.db_lock_retry.max_attempts,
		baseDelayMs: config.db_lock_retry.base_delay_ms,
		maxDelayMs: config.db_lock_retry.max_delay_ms,
	});

	return {
		config,
		dataDir,
		configPath,
		db,
		logger,
		progress: createProgress(),
	};
}

export async function closeContext(ctx: AppContext): Promise<void> {
	try {
		await ctx.db.close();
	} catch {
		// best effort
	}
}
