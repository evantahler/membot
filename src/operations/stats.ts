import { z } from "zod";
import type { DbConnection, SqlParam } from "../db/connection.ts";
import { listDueRefreshes } from "../db/files.ts";
import { colors } from "../output/formatter.ts";
import { defineOperation } from "./types.ts";

export const statsOperation = defineOperation({
	name: "membot_stats",
	cliName: "stats",
	description: `Summarize the local membot index: file/version/chunk/blob counts, total content and on-disk size, refresh health, and breakdowns by source_type, downloader, and mime_type. Optional prefix narrows aggregates to a subtree (same semantics as 'membot tree <prefix>'). Read-only. Use this before membot_prune to gauge how much there is to drop, or as a first call to confirm the index has anything in it.`,
	inputSchema: z.object({
		prefix: z
			.string()
			.optional()
			.describe(
				"Restrict aggregates to logical paths starting with this prefix (e.g. 'docs/api/'). Omit to summarize the whole index.",
			),
	}),
	outputSchema: z.object({
		prefix: z.string().nullable(),
		db_path: z.string(),
		db_size_bytes: z.number(),
		files: z.object({
			current: z.number(),
			tombstoned_paths: z.number(),
			total_versions: z.number(),
			distinct_paths: z.number(),
			by_source_type: z.record(z.string(), z.number()),
			by_downloader: z.record(z.string(), z.number()),
			by_mime_type: z.record(z.string(), z.number()),
		}),
		content: z.object({
			total_bytes: z.number(),
			total_versions_bytes: z.number(),
		}),
		chunks: z.object({
			current: z.number(),
			total: z.number(),
		}),
		blobs: z.object({
			count: z.number(),
			total_bytes: z.number(),
		}),
		refresh: z.object({
			scheduled: z.number(),
			due_now: z.number(),
			last_status: z.record(z.string(), z.number()),
		}),
	}),
	cli: { positional: ["prefix"] },
	console_formatter: (result) => {
		const lines: string[] = [];
		const heading = (s: string) => colors.bold(s);
		// Always leave at least 2 spaces between key and value, even when the
		// key is wider than the target column (long mime types, long keys).
		const kv = (k: string, v: string, indent = 0) => {
			const target = Math.max(22 - indent, k.length + 2);
			return `${" ".repeat(indent)}${colors.dim(k.padEnd(target))}${v}`;
		};
		const orNone = (record: Record<string, number>): string[] => {
			const keys = Object.keys(record);
			if (keys.length === 0) return [`  ${colors.dim("(none)")}`];
			return keys.map((k) => kv(k, String(record[k]), 4));
		};
		const header = result.prefix
			? `${heading("membot index summary")} ${colors.dim(`[prefix=${result.prefix}]`)}`
			: heading("membot index summary");
		lines.push(header);
		lines.push(kv("db_path", result.db_path));
		lines.push(kv("db_size_bytes", formatBytes(result.db_size_bytes)));

		lines.push("");
		lines.push(heading("files"));
		lines.push(kv("current", String(result.files.current), 2));
		lines.push(kv("tombstoned_paths", String(result.files.tombstoned_paths), 2));
		lines.push(kv("total_versions", String(result.files.total_versions), 2));
		lines.push(kv("distinct_paths", String(result.files.distinct_paths), 2));
		lines.push(kv("by_source_type", "", 2));
		lines.push(...orNone(result.files.by_source_type));
		lines.push(kv("by_downloader", "", 2));
		lines.push(...orNone(result.files.by_downloader));
		lines.push(kv("by_mime_type", "", 2));
		lines.push(...orNone(result.files.by_mime_type));

		lines.push("");
		lines.push(heading("content"));
		lines.push(kv("total_bytes", formatBytes(result.content.total_bytes), 2));
		lines.push(kv("total_versions_bytes", formatBytes(result.content.total_versions_bytes), 2));

		lines.push("");
		lines.push(heading("chunks"));
		lines.push(kv("current", String(result.chunks.current), 2));
		lines.push(kv("total", String(result.chunks.total), 2));

		lines.push("");
		lines.push(heading("blobs"));
		lines.push(kv("count", String(result.blobs.count), 2));
		lines.push(kv("total_bytes", formatBytes(result.blobs.total_bytes), 2));

		lines.push("");
		lines.push(heading("refresh"));
		lines.push(kv("scheduled", String(result.refresh.scheduled), 2));
		lines.push(kv("due_now", String(result.refresh.due_now), 2));
		lines.push(kv("last_status", "", 2));
		lines.push(...orNone(result.refresh.last_status));

		return lines.join("\n");
	},
	handler: async (input, ctx) => {
		const prefix = input.prefix ?? null;
		const dbSize = await dbFileSize(ctx.db.path);

		const files = await collectFileStats(ctx.db, prefix);
		const content = await collectContentStats(ctx.db, prefix);
		const chunks = await collectChunkStats(ctx.db, prefix);
		const blobs = await collectBlobStats(ctx.db, prefix);
		const refresh = await collectRefreshStats(ctx.db, prefix);

		return {
			prefix,
			db_path: ctx.db.path,
			db_size_bytes: dbSize,
			files,
			content,
			chunks,
			blobs,
			refresh,
		};
	},
});

/** Stat the DuckDB file. Returns 0 if the file isn't on disk yet (in-memory or freshly opened). */
async function dbFileSize(path: string): Promise<number> {
	try {
		const f = Bun.file(path);
		const exists = await f.exists();
		return exists ? f.size : 0;
	} catch {
		return 0;
	}
}

/** Build a `logical_path LIKE ?1` clause + params, or empty when prefix is null. */
function prefixFilter(prefix: string | null): { clause: string; params: SqlParam[] } {
	if (!prefix) return { clause: "", params: [] };
	return { clause: "logical_path LIKE ?1", params: [`${prefix}%`] };
}

/** Combine an existing WHERE fragment with an optional prefix filter. */
function and(base: string, extra: string): string {
	if (!base) return extra;
	if (!extra) return base;
	return `${base} AND ${extra}`;
}

interface FileStats {
	current: number;
	tombstoned_paths: number;
	total_versions: number;
	distinct_paths: number;
	by_source_type: Record<string, number>;
	by_downloader: Record<string, number>;
	by_mime_type: Record<string, number>;
}

async function collectFileStats(db: DbConnection, prefix: string | null): Promise<FileStats> {
	const pf = prefixFilter(prefix);
	const where = pf.clause ? `WHERE ${pf.clause}` : "";

	const current = await scalar(db, `SELECT COUNT(*) AS n FROM current_files ${where}`, ...pf.params);
	const totalVersions = await scalar(db, `SELECT COUNT(*) AS n FROM files ${where}`, ...pf.params);
	const distinctPaths = await scalar(db, `SELECT COUNT(DISTINCT logical_path) AS n FROM files ${where}`, ...pf.params);
	// Tombstoned path = a logical_path whose latest (max version_id) row is a tombstone.
	// current_files already excludes those, so we join "latest per path" against files
	// and count rows where tombstone = TRUE.
	const tombstonedPaths = await scalar(
		db,
		`SELECT COUNT(*) AS n
		 FROM files f
		 JOIN (
			SELECT logical_path, MAX(version_id) AS v FROM files ${where} GROUP BY logical_path
		 ) m ON f.logical_path = m.logical_path AND f.version_id = m.v
		 WHERE f.tombstone = TRUE`,
		...pf.params,
	);

	const by_source_type = await groupCount(db, "source_type", "current_files", pf);
	const by_downloader = await groupCount(db, "downloader", "current_files", pf, { skipNull: true });
	const by_mime_type = await groupCount(db, "mime_type", "current_files", pf, { topN: 10, skipNull: true });

	return {
		current,
		tombstoned_paths: tombstonedPaths,
		total_versions: totalVersions,
		distinct_paths: distinctPaths,
		by_source_type,
		by_downloader,
		by_mime_type,
	};
}

async function collectContentStats(
	db: DbConnection,
	prefix: string | null,
): Promise<{ total_bytes: number; total_versions_bytes: number }> {
	const pf = prefixFilter(prefix);
	const where = pf.clause ? `WHERE ${pf.clause}` : "";
	const total_bytes = await scalar(
		db,
		`SELECT COALESCE(SUM(size_bytes), 0) AS n FROM current_files ${where}`,
		...pf.params,
	);
	const total_versions_bytes = await scalar(
		db,
		`SELECT COALESCE(SUM(size_bytes), 0) AS n FROM files ${where}`,
		...pf.params,
	);
	return { total_bytes, total_versions_bytes };
}

async function collectChunkStats(db: DbConnection, prefix: string | null): Promise<{ current: number; total: number }> {
	if (!prefix) {
		const current = await scalar(db, `SELECT COUNT(*) AS n FROM current_chunks`);
		const total = await scalar(db, `SELECT COUNT(*) AS n FROM chunks`);
		return { current, total };
	}
	const pf = prefixFilter(prefix);
	const current = await scalar(db, `SELECT COUNT(*) AS n FROM current_chunks WHERE ${pf.clause}`, ...pf.params);
	const total = await scalar(db, `SELECT COUNT(*) AS n FROM chunks WHERE ${pf.clause}`, ...pf.params);
	return { current, total };
}

async function collectBlobStats(
	db: DbConnection,
	prefix: string | null,
): Promise<{ count: number; total_bytes: number }> {
	if (!prefix) {
		const row = await db.queryGet<{ count: number | bigint; total: number | bigint | null }>(
			`SELECT COUNT(*) AS count, COALESCE(SUM(size_bytes), 0) AS total FROM blobs`,
		);
		return { count: Number(row?.count ?? 0), total_bytes: Number(row?.total ?? 0) };
	}
	const pf = prefixFilter(prefix);
	const row = await db.queryGet<{ count: number | bigint; total: number | bigint | null }>(
		`SELECT COUNT(*) AS count, COALESCE(SUM(size_bytes), 0) AS total
		 FROM blobs
		 WHERE sha256 IN (
			SELECT blob_sha256 FROM current_files
			WHERE ${pf.clause} AND blob_sha256 IS NOT NULL
		 )`,
		...pf.params,
	);
	return { count: Number(row?.count ?? 0), total_bytes: Number(row?.total ?? 0) };
}

async function collectRefreshStats(
	db: DbConnection,
	prefix: string | null,
): Promise<{ scheduled: number; due_now: number; last_status: Record<string, number> }> {
	const pf = prefixFilter(prefix);
	const scheduledWhere = and(pf.clause, "refresh_frequency_sec IS NOT NULL");
	const scheduled = await scalar(db, `SELECT COUNT(*) AS n FROM current_files WHERE ${scheduledWhere}`, ...pf.params);

	const due = await listDueRefreshes(db);
	const due_now = prefix ? due.filter((r) => r.logical_path.startsWith(prefix)).length : due.length;

	const statusRows = await db.queryAll<{ k: string | null; n: number | bigint }>(
		`SELECT last_refresh_status AS k, COUNT(*) AS n
		 FROM current_files
		 WHERE last_refresh_status IS NOT NULL${pf.clause ? ` AND ${pf.clause}` : ""}
		 GROUP BY last_refresh_status
		 ORDER BY n DESC`,
		...pf.params,
	);
	const last_status: Record<string, number> = {};
	for (const r of statusRows) {
		if (r.k !== null) last_status[r.k] = Number(r.n);
	}

	return { scheduled, due_now, last_status };
}

/** Run a query whose first row has a single numeric column `n`, returning that number (0 when null). */
async function scalar(db: DbConnection, sql: string, ...params: SqlParam[]): Promise<number> {
	const row = await db.queryGet<{ n: number | bigint | null }>(sql, ...params);
	return Number(row?.n ?? 0);
}

interface GroupOptions {
	skipNull?: boolean;
	topN?: number;
}

/**
 * GROUP BY a column on a current_files-shaped table, optionally dropping NULLs
 * and rolling overflow into an "(other)" bucket when topN is set.
 */
async function groupCount(
	db: DbConnection,
	column: string,
	table: string,
	pf: { clause: string; params: SqlParam[] },
	opts: GroupOptions = {},
): Promise<Record<string, number>> {
	const filters: string[] = [];
	if (pf.clause) filters.push(pf.clause);
	if (opts.skipNull) filters.push(`${column} IS NOT NULL`);
	const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
	const rows = await db.queryAll<{ k: string | null; n: number | bigint }>(
		`SELECT ${column} AS k, COUNT(*) AS n FROM ${table} ${where} GROUP BY ${column} ORDER BY n DESC`,
		...pf.params,
	);
	const out: Record<string, number> = {};
	if (opts.topN && rows.length > opts.topN) {
		let other = 0;
		for (let i = 0; i < rows.length; i++) {
			const r = rows[i]!;
			const key = r.k ?? "(null)";
			if (i < opts.topN) out[key] = Number(r.n);
			else other += Number(r.n);
		}
		if (other > 0) out["(other)"] = other;
		return out;
	}
	for (const r of rows) {
		out[r.k ?? "(null)"] = Number(r.n);
	}
	return out;
}

/** Format a byte count in human units. 1024 boundary, 1-decimal precision past KB. */
function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KB", "MB", "GB", "TB"];
	let i = -1;
	let n = bytes;
	while (n >= 1024 && i < units.length - 1) {
		n /= 1024;
		i++;
	}
	return `${n.toFixed(n >= 100 ? 0 : 1)} ${units[i]}`;
}
