import { EMBEDDING_DIMENSION } from "../constants.ts";
import { HelpfulError } from "../errors.ts";
import type { DbConnection } from "./connection.ts";

export interface ChunkInput {
	chunk_index: number;
	chunk_content: string;
	search_text: string;
	embedding: number[];
}

export interface ChunkRow extends ChunkInput {
	logical_path: string;
	version_id: string;
}

/**
 * Insert all chunks for a given version. Throws `HelpfulError` if any
 * embedding's dimensionality doesn't match `EMBEDDING_DIMENSION` — DuckDB's
 * `FLOAT[N]` column would reject the bind, so we surface a clearer error
 * before reaching the driver.
 */
export async function insertChunksForVersion(
	db: DbConnection,
	logical_path: string,
	version_id: string,
	chunks: ChunkInput[],
): Promise<void> {
	for (const c of chunks) {
		if (c.embedding.length !== EMBEDDING_DIMENSION) {
			throw new HelpfulError({
				kind: "internal_error",
				message: `Chunk embedding dimension ${c.embedding.length} does not match expected ${EMBEDDING_DIMENSION}`,
				hint: `The embedding model must produce ${EMBEDDING_DIMENSION}-dim vectors. Check config.embedding_model.`,
			});
		}
		await db.queryRun(
			`INSERT INTO chunks (logical_path, version_id, chunk_index, chunk_content, search_text, embedding)
			 VALUES (?1, CAST(?2 AS TIMESTAMP), ?3, ?4, ?5, ?6::FLOAT[${EMBEDDING_DIMENSION}])`,
			logical_path,
			version_id,
			c.chunk_index,
			c.chunk_content,
			c.search_text,
			c.embedding,
		);
	}
}

/** Drop every chunk for a single version. Called by `deleteVersionAndChunks` during prune. */
export async function deleteChunksForVersion(
	db: DbConnection,
	logical_path: string,
	version_id: string,
): Promise<void> {
	await db.queryRun(
		`DELETE FROM chunks WHERE logical_path = ?1 AND version_id = CAST(?2 AS TIMESTAMP)`,
		logical_path,
		version_id,
	);
}

interface RawChunkRow {
	logical_path: string;
	version_id: string;
	chunk_index: number;
	chunk_content: string;
	search_text: string;
	embedding: number[];
	[key: string]: unknown;
}

/** All chunks for a single version, ordered by `chunk_index`. */
export async function listChunksForVersion(
	db: DbConnection,
	logical_path: string,
	version_id: string,
): Promise<ChunkRow[]> {
	const rows = await db.queryAll<RawChunkRow>(
		`SELECT logical_path, CAST(version_id AS VARCHAR) AS version_id,
		        chunk_index, chunk_content, search_text, embedding
		 FROM chunks
		 WHERE logical_path = ?1 AND version_id = CAST(?2 AS TIMESTAMP)
		 ORDER BY chunk_index`,
		logical_path,
		version_id,
	);
	return rows.map((r) => ({
		...r,
		version_id: String(r.version_id),
		chunk_index: Number(r.chunk_index),
	}));
}

let ftsAttempted = false;
let ftsAvailable = false;

/**
 * Build/refresh the FTS index over `current_chunks(search_text)`. DuckDB's FTS
 * is a snapshot — call this after batch inserts/deletes that change the
 * current_chunks set. The first call attempts to LOAD fts; subsequent failures
 * are silently swallowed so search degrades to semantic-only on platforms
 * where the extension can't load.
 */
export async function rebuildFts(db: DbConnection): Promise<boolean> {
	if (!ftsAttempted) {
		ftsAttempted = true;
		try {
			await db.exec(`INSTALL fts`);
			await db.exec(`LOAD fts`);
			ftsAvailable = true;
		} catch {
			ftsAvailable = false;
			return false;
		}
	}
	if (!ftsAvailable) return false;

	const sample = await db.queryGet<{ n: number }>(`SELECT COUNT(*) AS n FROM current_chunks`);
	if (!sample || Number(sample.n) === 0) return false;

	try {
		// FTS over current_chunks (a view) requires materializing into a table.
		// Drop & recreate the materialized projection on each rebuild.
		await db.exec(`DROP TABLE IF EXISTS _current_chunks_fts`);
		await db.exec(
			`CREATE TABLE _current_chunks_fts AS
			 SELECT (logical_path || '::' || CAST(version_id AS VARCHAR) || '::' || chunk_index) AS row_key,
			        logical_path, CAST(version_id AS VARCHAR) AS version_id, chunk_index, search_text
			 FROM current_chunks`,
		);
		await db.exec(
			`PRAGMA create_fts_index('_current_chunks_fts', 'row_key', 'search_text', stemmer='porter', overwrite=1)`,
		);
		await db.exec(`CHECKPOINT`);
		return true;
	} catch {
		return false;
	}
}

/**
 * True once `rebuildFts` has succeeded at least once in this process.
 * False until then, or permanently false on platforms where the DuckDB
 * `fts` extension cannot load — in which case search degrades to
 * semantic-only without erroring.
 */
export function isFtsAvailable(): boolean {
	return ftsAvailable;
}

/** Test-only: reset the cached extension-load state so per-test ephemeral DBs start clean. */
export function _resetFtsState(): void {
	ftsAttempted = false;
	ftsAvailable = false;
}
