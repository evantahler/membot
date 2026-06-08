import { logger } from "../output/logger.ts";
import type { DbConnection } from "./connection.ts";
import { MIGRATION_001 } from "./migrations/001-init.ts";
import { MIGRATION_002 } from "./migrations/002-fts.ts";
import { MIGRATION_003 } from "./migrations/003-downloader-columns.ts";
import { MIGRATION_004 } from "./migrations/004-nullable-blob-bytes.ts";
import { MIGRATION_006 } from "./migrations/006-search-quality.ts";

/**
 * One DDL/DML migration step. The id is monotonically increasing; the name
 * is for logging only. Each statement runs independently so PRAGMA / INSTALL
 * / LOAD calls (which DuckDB doesn't allow in multi-statement strings) work.
 *
 * `transactional` defaults to true: `statements` and the matching
 * `_migrations` insert run inside a single BEGIN/COMMIT so the WAL only ever
 * sees the completed post-migration shape (avoids partial-state replay races
 * like the one in issue #54 on ALTER TABLE DROP COLUMN). Set it to false for
 * migrations whose statements DuckDB doesn't accept inside an explicit
 * transaction (INSTALL / LOAD).
 *
 * `preStatements` always run auto-committed, before the transaction opens.
 * Use this for setup whose side effects must be visible to the transactional
 * block — notably DROP INDEX, which DuckDB doesn't materialize within the
 * same transaction when a later ALTER TABLE DROP COLUMN checks index
 * dependencies.
 */
export interface Migration {
	id: number;
	name: string;
	statements: string[];
	preStatements?: string[];
	transactional?: boolean;
}

// Note: id 5 is reserved by the in-flight relationships work; 006 ships
// independently so the two changes don't contend for the same slot.
const MIGRATIONS: Migration[] = [MIGRATION_001, MIGRATION_002, MIGRATION_003, MIGRATION_004, MIGRATION_006];

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
 *
 * Tests may pass a custom `migrations` list (e.g. to inject a deliberately
 * failing step and assert rollback). Production code uses the default.
 */
export async function applyMigrations(db: DbConnection, migrations: Migration[] = MIGRATIONS): Promise<boolean> {
	if (checkedPaths.has(db.path)) return false;

	await db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
		id INTEGER PRIMARY KEY,
		name TEXT NOT NULL,
		applied_at TIMESTAMP NOT NULL DEFAULT now()
	)`);

	const applied = await db.queryAll<{ id: number }>(`SELECT id FROM _migrations ORDER BY id`);
	const appliedIds = new Set(applied.map((r) => Number(r.id)));

	let appliedAny = false;
	for (const migration of migrations) {
		if (appliedIds.has(migration.id)) continue;
		const label = `${String(migration.id).padStart(3, "0")}-${migration.name}`;
		logger.info(`migration: applying ${label}`);
		for (const stmt of migration.preStatements ?? []) {
			const trimmed = stmt.trim();
			if (!trimmed) continue;
			await db.exec(trimmed);
		}
		const wrap = migration.transactional !== false;
		if (wrap) await db.exec("BEGIN TRANSACTION");
		try {
			for (const stmt of migration.statements) {
				const trimmed = stmt.trim();
				if (!trimmed) continue;
				await db.exec(trimmed);
			}
			await db.queryRun(`INSERT INTO _migrations(id, name) VALUES (?1, ?2)`, migration.id, migration.name);
			if (wrap) await db.exec("COMMIT");
		} catch (err) {
			if (wrap) {
				// Best effort — if ROLLBACK itself fails (already aborted, no active
				// transaction, etc.) we still want the original error to surface.
				await db.exec("ROLLBACK").catch(() => {});
			}
			throw err;
		}
		appliedAny = true;
		logger.info(`migration: applied  ${label}`);
	}

	checkedPaths.add(db.path);
	return appliedAny;
}
