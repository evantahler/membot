import type { DbConnection, SqlParam } from "./connection.ts";

export type SourceType = "local" | "remote" | "inline";
export type FetcherKind = "downloader" | "local" | "inline";

export interface FileRow {
	logical_path: string;
	version_id: string;
	tombstone: boolean;
	source_type: SourceType;
	source_path: string | null;
	source_mtime_ms: number | null;
	source_sha256: string | null;
	blob_sha256: string | null;
	content_sha256: string | null;
	content: string | null;
	description: string | null;
	mime_type: string | null;
	size_bytes: number | null;
	fetcher: FetcherKind | null;
	downloader: string | null;
	downloader_args: Record<string, unknown> | null;
	refresh_frequency_sec: number | null;
	refreshed_at: string | null;
	last_refresh_status: string | null;
	change_note: string | null;
	created_at: string;
}

export interface NewFileVersion {
	logical_path: string;
	version_id?: string;
	tombstone?: boolean;
	source_type: SourceType;
	source_path?: string | null;
	source_mtime_ms?: number | null;
	source_sha256?: string | null;
	blob_sha256?: string | null;
	content_sha256?: string | null;
	content?: string | null;
	description?: string | null;
	mime_type?: string | null;
	size_bytes?: number | null;
	fetcher?: FetcherKind | null;
	downloader?: string | null;
	downloader_args?: Record<string, unknown> | null;
	refresh_frequency_sec?: number | null;
	refreshed_at?: string | null;
	last_refresh_status?: string | null;
	change_note?: string | null;
}

const ROW_COLUMNS = [
	"logical_path",
	"version_id",
	"tombstone",
	"source_type",
	"source_path",
	"source_mtime_ms",
	"source_sha256",
	"blob_sha256",
	"content_sha256",
	"content",
	"description",
	"mime_type",
	"size_bytes",
	"fetcher",
	"downloader",
	"downloader_args",
	"refresh_frequency_sec",
	"refreshed_at",
	"last_refresh_status",
	"change_note",
	"created_at",
] as const;

const COLUMN_LIST = ROW_COLUMNS.join(", ");

/**
 * Insert a new (logical_path, version_id) row. Returns the assigned version_id.
 * If `version_id` is omitted, uses `now()` at millisecond precision; the caller
 * should retry with a bumped timestamp on the rare collision case.
 */
export async function insertVersion(db: DbConnection, file: NewFileVersion): Promise<string> {
	const versionId = file.version_id ?? millisIso(Date.now());
	const downloaderArgsJson = file.downloader_args ? JSON.stringify(file.downloader_args) : null;

	await db.queryRun(
		`INSERT INTO files (
			logical_path, version_id, tombstone, source_type,
			source_path, source_mtime_ms, source_sha256, blob_sha256,
			content_sha256, content, description, mime_type, size_bytes,
			fetcher, downloader, downloader_args,
			refresh_frequency_sec, refreshed_at, last_refresh_status, change_note
		) VALUES (
			?1, CAST(?2 AS TIMESTAMP), ?3, ?4,
			?5, ?6, ?7, ?8,
			?9, ?10, ?11, ?12, ?13,
			?14, ?15, ?16,
			?17, ?18, ?19, ?20
		)`,
		file.logical_path,
		versionId,
		!!file.tombstone,
		file.source_type,
		file.source_path ?? null,
		file.source_mtime_ms ?? null,
		file.source_sha256 ?? null,
		file.blob_sha256 ?? null,
		file.content_sha256 ?? null,
		file.content ?? null,
		file.description ?? null,
		file.mime_type ?? null,
		file.size_bytes ?? null,
		file.fetcher ?? null,
		file.downloader ?? null,
		downloaderArgsJson,
		file.refresh_frequency_sec ?? null,
		file.refreshed_at ?? null,
		file.last_refresh_status ?? null,
		file.change_note ?? null,
	);
	return versionId;
}

/** Convert a unix-millis number to an ISO string at ms precision. */
export function millisIso(ms: number): string {
	return new Date(ms).toISOString();
}

interface RawFileRow extends Omit<FileRow, "downloader_args" | "tombstone"> {
	downloader_args: string | null | Record<string, unknown>;
	tombstone: boolean | number;
	[key: string]: unknown;
}

/**
 * Coerce a raw DuckDB row into a typed `FileRow`. JSON-parses the
 * `downloader_args` column (DuckDB returns it as text or a parsed object
 * depending on driver version) and normalizes `tombstone` to a boolean
 * (some drivers return 0/1).
 */
function toFileRow(row: RawFileRow | null): FileRow | null {
	if (!row) return null;
	let parsed: Record<string, unknown> | null = null;
	if (row.downloader_args && typeof row.downloader_args === "string") {
		try {
			parsed = JSON.parse(row.downloader_args);
		} catch {
			parsed = null;
		}
	} else if (row.downloader_args && typeof row.downloader_args === "object") {
		parsed = row.downloader_args;
	}
	return {
		...row,
		downloader_args: parsed,
		tombstone: !!row.tombstone,
	};
}

/** Fetch the current (latest non-tombstoned) row for a logical_path, or null. */
export async function getCurrent(db: DbConnection, logicalPath: string): Promise<FileRow | null> {
	const row = await db.queryGet<RawFileRow>(
		`SELECT ${COLUMN_LIST} FROM current_files WHERE logical_path = ?1`,
		logicalPath,
	);
	return toFileRow(row);
}

/** Fetch the exact (logical_path, version_id) row, or null if it doesn't exist. */
export async function getVersion(db: DbConnection, logicalPath: string, versionId: string): Promise<FileRow | null> {
	const row = await db.queryGet<RawFileRow>(
		`SELECT ${COLUMN_LIST} FROM files
		 WHERE logical_path = ?1 AND version_id = CAST(?2 AS TIMESTAMP)`,
		logicalPath,
		versionId,
	);
	return toFileRow(row);
}

/** All versions for a logical_path (including tombstones), newest first. */
export async function listVersions(db: DbConnection, logicalPath: string): Promise<FileRow[]> {
	const rows = await db.queryAll<RawFileRow>(
		`SELECT ${COLUMN_LIST} FROM files WHERE logical_path = ?1 ORDER BY version_id DESC`,
		logicalPath,
	);
	return rows.map((r) => toFileRow(r) as FileRow);
}

export interface ListCurrentOptions {
	prefix?: string;
	limit?: number;
	offset?: number;
}

/**
 * List current (latest, non-tombstoned) rows ordered by logical_path.
 * `prefix` filters to paths starting with the given string. `limit` defaults
 * to 1000 and `offset` to 0; together they support cursor-style pagination.
 */
export async function listCurrent(db: DbConnection, options: ListCurrentOptions = {}): Promise<FileRow[]> {
	const where: string[] = [];
	const params: SqlParam[] = [];
	if (options.prefix) {
		where.push(`logical_path LIKE ?${params.length + 1}`);
		params.push(`${options.prefix}%`);
	}
	const limit = options.limit ?? 1000;
	const offset = options.offset ?? 0;
	const sql = `SELECT ${COLUMN_LIST} FROM current_files
		${where.length ? `WHERE ${where.join(" AND ")}` : ""}
		ORDER BY logical_path
		LIMIT ${Number(limit)} OFFSET ${Number(offset)}`;
	const rows = await db.queryAll<RawFileRow>(sql, ...params);
	return rows.map((r) => toFileRow(r) as FileRow);
}

/** Just the logical_paths of every current row, alphabetized. Used by `tree` and discovery flows. */
export async function listAllCurrentPaths(db: DbConnection): Promise<string[]> {
	const rows = await db.queryAll<{ logical_path: string }>(
		`SELECT logical_path FROM current_files ORDER BY logical_path`,
	);
	return rows.map((r) => r.logical_path);
}

/** Insert a tombstone version for the given path. */
export async function tombstone(db: DbConnection, logicalPath: string, changeNote?: string): Promise<string> {
	return insertVersion(db, {
		logical_path: logicalPath,
		source_type: "inline",
		tombstone: true,
		content: "",
		change_note: changeNote ?? null,
	});
}

/** Update only the mutable status fields on the latest row for a logical_path. */
export async function updateRefreshStatus(
	db: DbConnection,
	logicalPath: string,
	versionId: string,
	status: { refreshed_at: string; last_refresh_status: string },
): Promise<void> {
	await db.queryRun(
		`UPDATE files
		 SET refreshed_at = CAST(?1 AS TIMESTAMP),
		     last_refresh_status = ?2
		 WHERE logical_path = ?3 AND version_id = CAST(?4 AS TIMESTAMP)`,
		status.refreshed_at,
		status.last_refresh_status,
		logicalPath,
		versionId,
	);
}

export interface DueRefreshRow {
	logical_path: string;
	version_id: string;
	refresh_frequency_sec: number;
	refreshed_at: string | null;
	[key: string]: unknown;
}

/** Rows whose refresh frequency has elapsed (current versions only). */
export async function listDueRefreshes(db: DbConnection): Promise<DueRefreshRow[]> {
	const rows = await db.queryAll<DueRefreshRow>(
		`SELECT logical_path, CAST(version_id AS VARCHAR) AS version_id,
		        refresh_frequency_sec,
		        CAST(refreshed_at AS VARCHAR) AS refreshed_at
		 FROM current_files
		 WHERE refresh_frequency_sec IS NOT NULL
		   AND (refreshed_at IS NULL
				OR CURRENT_TIMESTAMP > refreshed_at + (refresh_frequency_sec * INTERVAL '1 second'))`,
	);
	return rows.map((r) => ({
		logical_path: r.logical_path,
		version_id: String(r.version_id),
		refresh_frequency_sec: Number(r.refresh_frequency_sec),
		refreshed_at: r.refreshed_at ? String(r.refreshed_at) : null,
	}));
}

/**
 * Delete non-current versions whose version_id is older than `beforeIso`.
 * Returns the count of removed file rows. Tombstones for paths with no
 * newer version are preserved (they are themselves the current row).
 */
export async function pruneOldVersions(db: DbConnection, beforeIso: string): Promise<{ removed: number }> {
	// Versions older than cutoff that are NOT the current version for their path.
	const result = await db.queryRun(
		`DELETE FROM files
		 WHERE version_id < CAST(?1 AS TIMESTAMP)
		   AND (logical_path, version_id) NOT IN (
		     SELECT logical_path, MAX(version_id) FROM files GROUP BY logical_path
		   )`,
		beforeIso,
	);
	return { removed: result.changes };
}

/**
 * Hard-delete a single (logical_path, version_id) row and its chunks.
 * Bypasses the append-only versioning model — used by `prune` to reclaim
 * space. Prefer `tombstone()` for user-driven deletes so history is
 * preserved.
 */
export async function deleteVersionAndChunks(db: DbConnection, logicalPath: string, versionId: string): Promise<void> {
	await db.queryRun(
		`DELETE FROM chunks WHERE logical_path = ?1 AND version_id = CAST(?2 AS TIMESTAMP)`,
		logicalPath,
		versionId,
	);
	await db.queryRun(
		`DELETE FROM files WHERE logical_path = ?1 AND version_id = CAST(?2 AS TIMESTAMP)`,
		logicalPath,
		versionId,
	);
}

export { COLUMN_LIST as FILE_COLUMNS };
