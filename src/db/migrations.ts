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
 * Apply every unapplied migration in id order. Tracks applied ids in
 * `_migrations`. Each successful run is logged via the shared logger so a
 * user upgrading membot can see exactly what changed in their store.
 */
export async function applyMigrations(db: DbConnection): Promise<void> {
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
}
