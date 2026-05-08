import { logger } from "../output/logger.ts";
import type { DbConnection } from "./connection.ts";
import { MIGRATION_001 } from "./migrations/001-init.ts";
import { MIGRATION_002 } from "./migrations/002-fts.ts";

/**
 * One DDL/DML migration step. The id is monotonically increasing; the name
 * is for logging only. Each statement runs independently so PRAGMA / INSTALL
 * / LOAD calls (which DuckDB doesn't allow in multi-statement strings) work.
 */
export interface Migration {
	id: number;
	name: string;
	statements: string[];
}

const MIGRATIONS: Migration[] = [MIGRATION_001, MIGRATION_002];

/**
 * Process-level cache of paths whose migrations have been applied (or
 * confirmed already-current) in this process. With lazy-claim DB connections,
 * `applyMigrations` runs on every reopen — caching here keeps the DDL/SELECT
 * traffic and "migration: applied" log lines off the hot reopen path.
 * Cleared by `forgetMigrations` so tests can simulate a fresh process.
 */
const checkedPaths = new Set<string>();

/** Reset the per-process migration cache. Test-only — production code never calls this. */
export function forgetMigrations(path?: string): void {
	if (path === undefined) checkedPaths.clear();
	else checkedPaths.delete(path);
}

/**
 * Apply every unapplied migration in id order. Tracks applied ids in
 * `_migrations`. Each successful run is logged via the shared logger so a
 * user upgrading membot can see exactly what changed in their store. The
 * first call for a given DB path checks the table; subsequent calls in the
 * same process short-circuit via `checkedPaths`.
 */
export async function applyMigrations(db: DbConnection): Promise<void> {
	if (checkedPaths.has(db.path)) return;

	await db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
		id INTEGER PRIMARY KEY,
		name TEXT NOT NULL,
		applied_at TIMESTAMP NOT NULL DEFAULT now()
	)`);

	const applied = await db.queryAll<{ id: number }>(`SELECT id FROM _migrations ORDER BY id`);
	const appliedIds = new Set(applied.map((r) => Number(r.id)));

	for (const migration of MIGRATIONS) {
		if (appliedIds.has(migration.id)) continue;
		logger.info(`migration: applying ${String(migration.id).padStart(3, "0")}-${migration.name}`);
		for (const stmt of migration.statements) {
			const trimmed = stmt.trim();
			if (!trimmed) continue;
			await db.exec(trimmed);
		}
		await db.queryRun(`INSERT INTO _migrations(id, name) VALUES (?1, ?2)`, migration.id, migration.name);
		logger.info(`migration: applied  ${String(migration.id).padStart(3, "0")}-${migration.name}`);
	}

	checkedPaths.add(db.path);
}
