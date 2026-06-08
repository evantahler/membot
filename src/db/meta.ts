import { EMBEDDING_REVISION } from "../constants.ts";
import { logger } from "../output/logger.ts";
import type { DbConnection } from "./connection.ts";

/**
 * Read one value from the `meta` key/value table. Returns null when the key
 * has never been set (or on pre-006 DBs where the table doesn't exist yet —
 * migrations run at open, so that's unreachable in practice).
 */
export async function getMeta(db: DbConnection, key: string): Promise<string | null> {
	const row = await db.queryGet<{ value: string }>(`SELECT value FROM meta WHERE key = ?1`, key);
	return row ? String(row.value) : null;
}

/** Upsert one value into the `meta` key/value table. */
export async function setMeta(db: DbConnection, key: string, value: string): Promise<void> {
	await db.queryRun(
		`INSERT INTO meta (key, value, updated_at) VALUES (?1, ?2, now())
		 ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()`,
		key,
		value,
	);
}

/** Key under which the store's embedding revision is tracked. See `EMBEDDING_REVISION` in constants.ts. */
export const META_EMBEDDING_REVISION = "embedding_revision";

const staleWarned = new Set<string>();

/**
 * Warn (once per process per DB) when the store's vectors were built under
 * an older embedding revision than the running code produces. Mixed-revision
 * vectors still "work" — cosine distance returns numbers — but quality is
 * silently degraded because query and passage vectors live in different
 * spaces. The fix is a one-time `membot reindex --embeddings`.
 *
 * Returns true when the store is stale so callers (tests, doctors) can
 * assert on it; rendering happens here so every search surface gets the
 * warning without duplicating the copy.
 */
export async function warnIfStaleEmbeddingRevision(db: DbConnection): Promise<boolean> {
	const stored = await getMeta(db, META_EMBEDDING_REVISION);
	if (stored === null || stored === String(EMBEDDING_REVISION)) return false;
	if (!staleWarned.has(db.path)) {
		staleWarned.add(db.path);
		logger.warn(
			`this store's embeddings were built under revision ${stored}; current code produces revision ${EMBEDDING_REVISION} — semantic search quality is degraded until you run \`membot reindex --embeddings\``,
		);
	}
	return true;
}

/** Test-only: reset the once-per-process stale-revision warning latch. */
export function _resetStaleEmbeddingWarning(): void {
	staleWarned.clear();
}
