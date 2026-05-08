import { EMBEDDING_DIMENSION } from "../constants.ts";
import type { DbConnection } from "../db/connection.ts";

export interface SemanticHit {
	logical_path: string;
	version_id: string;
	chunk_index: number;
	chunk_content: string;
	search_text: string;
	score: number;
}

interface RawSemanticRow {
	logical_path: string;
	version_id: string;
	chunk_index: number;
	chunk_content: string;
	search_text: string;
	distance: number;
	[key: string]: unknown;
}

/**
 * Cosine-similarity search over the chunks' embedding vectors. Searches
 * `current_chunks` (latest non-tombstoned per logical_path) by default;
 * pass `includeHistory=true` to search every version.
 */
export async function searchSemantic(
	db: DbConnection,
	queryVec: number[],
	options: { limit?: number; pathPrefix?: string; includeHistory?: boolean } = {},
): Promise<SemanticHit[]> {
	const limit = options.limit ?? 50;
	const view = options.includeHistory ? "chunks" : "current_chunks";
	const prefixClause = options.pathPrefix ? `WHERE logical_path LIKE ?2` : "";
	const sql = `SELECT logical_path,
	                   CAST(version_id AS VARCHAR) AS version_id,
	                   chunk_index, chunk_content, search_text,
	                   array_cosine_distance(embedding, ?1::FLOAT[${EMBEDDING_DIMENSION}]) AS distance
	            FROM ${view}
	            ${prefixClause}
	            ORDER BY distance ASC
	            LIMIT ${Number(limit)}`;
	const rows: RawSemanticRow[] = options.pathPrefix
		? await db.queryAll<RawSemanticRow>(sql, queryVec, `${options.pathPrefix}%`)
		: await db.queryAll<RawSemanticRow>(sql, queryVec);

	return rows.map((r) => ({
		logical_path: r.logical_path,
		version_id: String(r.version_id),
		chunk_index: Number(r.chunk_index),
		chunk_content: r.chunk_content,
		search_text: r.search_text,
		score: 1 - Number(r.distance),
	}));
}
