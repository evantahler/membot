import { isFtsAvailable, rebuildFts } from "../db/chunks.ts";
import type { DbConnection } from "../db/connection.ts";

export interface KeywordHit {
	logical_path: string;
	version_id: string;
	chunk_index: number;
	chunk_content: string;
	search_text: string;
	score: number;
}

interface RawKeywordRow {
	row_key: string;
	logical_path: string;
	version_id: string;
	chunk_index: number;
	chunk_content: string;
	search_text: string;
	bm25_score: number;
	[key: string]: unknown;
}

/**
 * BM25 keyword search over `chunks.search_text` via the FTS extension.
 * Returns an empty list when FTS isn't available on this platform — the
 * hybrid layer treats missing keyword hits as "no signal" and degrades
 * to semantic-only.
 */
export async function searchKeyword(
	db: DbConnection,
	query: string,
	options: { limit?: number; pathPrefix?: string } = {},
): Promise<KeywordHit[]> {
	const built = await rebuildFts(db);
	if (!built && !isFtsAvailable()) return [];
	if (!isFtsAvailable()) return [];

	const limit = options.limit ?? 50;
	try {
		const sql = `SELECT row_key, logical_path, version_id, chunk_index,
		                   chunk_content, search_text,
		                   fts_main__current_chunks_fts.match_bm25(row_key, ?1) AS bm25_score
		            FROM _current_chunks_fts
		           WHERE fts_main__current_chunks_fts.match_bm25(row_key, ?1) IS NOT NULL
		             ${options.pathPrefix ? "AND logical_path LIKE ?2" : ""}
		           ORDER BY bm25_score DESC
		           LIMIT ${Number(limit)}`;
		const rows: RawKeywordRow[] = options.pathPrefix
			? await db.queryAll<RawKeywordRow>(sql, query, `${options.pathPrefix}%`)
			: await db.queryAll<RawKeywordRow>(sql, query);
		return rows.map((r) => ({
			logical_path: r.logical_path,
			version_id: String(r.version_id),
			chunk_index: Number(r.chunk_index),
			chunk_content: r.chunk_content,
			search_text: r.search_text,
			score: Number(r.bm25_score),
		}));
	} catch {
		return [];
	}
}
