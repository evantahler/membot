import type { DbConnection } from "./connection.ts";

export interface BlobRow {
	sha256: string;
	mime_type: string;
	size_bytes: number;
	bytes: Uint8Array;
}

/**
 * Insert a content-addressed blob, doing nothing when the sha256 already
 * exists. Uses an explicit `?::BLOB` cast because DuckDB can't infer the
 * column type from a JS Uint8Array on its own.
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

/** Fetch a blob by sha256, or null. Used when serving `membot_read bytes=true`. */
export async function readBlob(db: DbConnection, sha256: string): Promise<BlobRow | null> {
	const row = await db.queryGet<{
		sha256: string;
		mime_type: string;
		size_bytes: number;
		bytes: Uint8Array;
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
