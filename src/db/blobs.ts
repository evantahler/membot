import type { DbConnection } from "./connection.ts";

export interface BlobRow {
	sha256: string;
	mime_type: string;
	size_bytes: number;
	/**
	 * Original ingested bytes. `null` when ingest deliberately skipped
	 * persistence (config `blobs.max_size_bytes` / `blobs.skip_mime_types`)
	 * or when a previous `prune --strip-blob-bytes` nulled it out. The
	 * surrounding metadata is still authoritative for dedupe and refresh.
	 */
	bytes: Uint8Array | null;
}

/**
 * Insert a content-addressed blob, doing nothing when the sha256 already
 * exists. Uses an explicit `?::BLOB` cast because DuckDB can't infer the
 * column type from a JS Uint8Array on its own; the same cast also handles
 * the `null` case cleanly (`NULL::BLOB` is `NULL`).
 */
export async function upsertBlob(db: DbConnection, blob: BlobRow): Promise<void> {
	await db.queryRun(
		`INSERT INTO blobs (sha256, mime_type, size_bytes, bytes)
		 VALUES (?1, ?2, ?3, ?4::BLOB)
		 ON CONFLICT (sha256) DO NOTHING`,
		blob.sha256,
		blob.mime_type,
		blob.size_bytes,
		blob.bytes,
	);
}

/**
 * Fetch a blob by sha256, or null when no row exists at all. Note the
 * two-level "missing" distinction callers must handle: this returns
 * `null` for "no row" but a real `BlobRow` with `bytes: null` for
 * "row exists, bytes intentionally not persisted".
 */
export async function readBlob(db: DbConnection, sha256: string): Promise<BlobRow | null> {
	const row = await db.queryGet<{
		sha256: string;
		mime_type: string;
		size_bytes: number;
		bytes: Uint8Array | null;
	}>(`SELECT sha256, mime_type, size_bytes, bytes FROM blobs WHERE sha256 = ?1`, sha256);
	if (!row) return null;
	return {
		sha256: row.sha256,
		mime_type: row.mime_type,
		size_bytes: Number(row.size_bytes),
		bytes: row.bytes,
	};
}

/** Drop blobs whose sha256 isn't referenced by any non-tombstone file row. */
export async function gcOrphanBlobs(db: DbConnection): Promise<{ removed: number }> {
	const result = await db.queryRun(
		`DELETE FROM blobs
		 WHERE sha256 NOT IN (
			SELECT DISTINCT blob_sha256 FROM files WHERE blob_sha256 IS NOT NULL
		 )`,
	);
	return { removed: result.changes };
}

/**
 * Lightweight `blobs` row used by the prune retroactive-strip path.
 * Only the fields the policy predicate consumes (mime, size) plus the
 * primary key needed to issue the UPDATE.
 */
export interface BlobStripCandidate {
	sha256: string;
	mime_type: string;
	size_bytes: number;
}

/**
 * Enumerate all blobs whose `bytes` are currently persisted. Caller filters
 * the result through `shouldPersistBlobBytes` to decide which to strip;
 * keeping that decision in user-land keeps the policy in one place.
 */
export async function listBlobsWithBytes(db: DbConnection): Promise<BlobStripCandidate[]> {
	const rows = await db.queryAll<{ sha256: string; mime_type: string; size_bytes: number | bigint }>(
		`SELECT sha256, mime_type, size_bytes FROM blobs WHERE bytes IS NOT NULL`,
	);
	return rows.map((r) => ({ sha256: r.sha256, mime_type: r.mime_type, size_bytes: Number(r.size_bytes) }));
}

/**
 * NULL out `bytes` on the rows whose sha256 is in the provided list.
 * Returns the number of bytes reclaimed (sum of `octet_length(bytes)`
 * before the update) so the caller can report space recovered without
 * a separate before/after stats query.
 */
export async function stripBlobBytes(
	db: DbConnection,
	sha256s: string[],
): Promise<{ stripped: number; reclaimed_bytes: number }> {
	if (sha256s.length === 0) return { stripped: 0, reclaimed_bytes: 0 };
	// Build a positional placeholder list (?1, ?2, ...) — DuckDB's @duckdb/node-api
	// can't bind a JS array directly into an `IN (...)` slot, and we'd rather not
	// stand up a temp table for this. We measure with octet_length first so
	// reclaimed_bytes is the real on-disk delta, not the (possibly stale)
	// size_bytes column.
	const placeholders = sha256s.map((_, i) => `?${i + 1}`).join(", ");
	const beforeRow = await db.queryGet<{ n: number | bigint | null }>(
		`SELECT COALESCE(SUM(octet_length(bytes)), 0) AS n FROM blobs
		 WHERE sha256 IN (${placeholders}) AND bytes IS NOT NULL`,
		...sha256s,
	);
	const reclaimed = Number(beforeRow?.n ?? 0);
	const res = await db.queryRun(
		`UPDATE blobs SET bytes = NULL
		 WHERE sha256 IN (${placeholders}) AND bytes IS NOT NULL`,
		...sha256s,
	);
	return { stripped: res.changes, reclaimed_bytes: reclaimed };
}
