import { EMBEDDING_DIMENSION } from "../constants.ts";
import { asHelpful, HelpfulError } from "../errors.ts";
import { logger } from "../output/logger.ts";
import type { DbConnection } from "./connection.ts";

export interface ChunkInput {
	chunk_index: number;
	chunk_content: string;
	search_text: string;
	embedding: number[];
	/**
	 * Heading breadcrumb scoping this chunk ("Doc > Section"), or null.
	 * Persisted so operations that re-derive `search_text` from stored chunks
	 * (move) can rebuild the same string without re-running the chunker.
	 */
	context?: string | null;
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
			`INSERT INTO chunks (logical_path, version_id, chunk_index, chunk_content, search_text, embedding, context)
			 VALUES (?1, CAST(?2 AS TIMESTAMP), ?3, ?4, ?5, ?6::FLOAT[${EMBEDDING_DIMENSION}], ?7)`,
			logical_path,
			version_id,
			c.chunk_index,
			c.chunk_content,
			c.search_text,
			c.embedding,
			c.context ?? null,
		);
	}
}

/**
 * Rebuild the `chunks` table from its own contents into a fresh table and
 * swap it in, regenerating the PRIMARY KEY ART index from scratch.
 *
 * This is the recovery path for a store whose chunks index has drifted out of
 * sync with the table data. The symptom is DuckDB raising
 * `FATAL Error: ... Failed to delete all rows from index. Only deleted N out
 * of M rows` on the next `DELETE` against an affected version — which happens
 * during `reindex --embeddings` (per-version delete + re-insert) and, because
 * it fires inside an explicit transaction, escapes through Bun's native
 * boundary as an uncatchable C++ exception (process SIGTRAP). A `SELECT` from
 * the table still works, so copying the rows into a fresh table rebuilds a
 * clean index without losing data.
 *
 * Row contents are preserved exactly (only the derived index is regenerated)
 * and the whole swap runs in one transaction, so a failure leaves the original
 * table intact. Throws `HelpfulError` if the source rows contain duplicate
 * primary keys (a deeper corruption the rebuild can't silently paper over).
 */
export async function rebuildChunksTable(db: DbConnection): Promise<{ rows: number }> {
	const before = await db.queryGet<{ n: number }>(`SELECT COUNT(*) AS n FROM chunks`);
	const rows = before ? Number(before.n) : 0;
	logger.info(`reindex: rebuilding chunks table (${rows} chunks) to regenerate the primary-key index`);
	await db.exec("BEGIN TRANSACTION");
	try {
		// current_chunks depends on chunks, so it has to be dropped before the
		// table can be swapped, then recreated identically afterwards.
		await db.exec(`DROP VIEW IF EXISTS current_chunks`);
		await db.exec(
			`CREATE TABLE chunks_rebuild (
				logical_path   TEXT NOT NULL,
				version_id     TIMESTAMP NOT NULL,
				chunk_index    INTEGER NOT NULL,
				chunk_content  TEXT NOT NULL,
				search_text    TEXT NOT NULL,
				embedding      FLOAT[${EMBEDDING_DIMENSION}] NOT NULL,
				context        TEXT,
				PRIMARY KEY (logical_path, version_id, chunk_index)
			)`,
		);
		// The INSERT builds a fresh ART index; duplicate PKs in the source would
		// raise a constraint violation here rather than corrupt the new table.
		await db.exec(
			`INSERT INTO chunks_rebuild
			 SELECT logical_path, version_id, chunk_index, chunk_content, search_text, embedding, context
			 FROM chunks`,
		);
		await db.exec(`DROP TABLE chunks`);
		await db.exec(`ALTER TABLE chunks_rebuild RENAME TO chunks`);
		await db.exec(`CREATE INDEX chunks_path_idx ON chunks (logical_path)`);
		await db.exec(
			`CREATE VIEW current_chunks AS
			 SELECT c.* FROM chunks c
			 JOIN current_files cf USING (logical_path, version_id)`,
		);
		await db.exec("COMMIT");
	} catch (err) {
		await db.exec("ROLLBACK").catch(() => {
			// Best effort — surface the original error.
		});
		throw asHelpful(
			err,
			"while rebuilding the chunks table for recovery",
			"If this reports a duplicate primary key, the chunks table holds duplicate (logical_path, version_id, chunk_index) rows — inspect with `membot` SQL before retrying. Otherwise the original table was left intact; re-run `membot reindex --embeddings --recovery`.",
			"internal_error",
		);
	}
	return { rows };
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
	context: string | null;
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
		        chunk_index, chunk_content, search_text, embedding, context
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
		context: r.context ?? null,
	}));
}

/**
 * Outcome of a `rebuildFts` call. Distinct kinds let callers (and the
 * `reindex` CLI) distinguish "empty DB — that's fine" from "extension truly
 * couldn't load — search will degrade".
 */
export type RebuildFtsResult =
	| { kind: "rebuilt"; chunk_count: number }
	| { kind: "extension_unavailable"; cause?: string }
	| { kind: "no_chunks" }
	| { kind: "rebuild_failed"; cause?: string };

let ftsAttempted = false;
let ftsAvailable = false;
let ftsLoadError: string | undefined;

/**
 * Build/refresh the FTS index over `current_chunks(search_text)`. DuckDB's FTS
 * is a snapshot — call this after batch inserts/deletes that change the
 * current_chunks set. The first call attempts to LOAD fts; on failure the
 * underlying error is captured and returned via `extension_unavailable.cause`
 * so callers can render it diagnostically.
 */
export async function rebuildFts(db: DbConnection): Promise<RebuildFtsResult> {
	if (!ftsAttempted) {
		ftsAttempted = true;
		try {
			await db.exec(`INSTALL fts`);
			await db.exec(`LOAD fts`);
			ftsAvailable = true;
		} catch (e) {
			ftsAvailable = false;
			ftsLoadError = errorMessage(e);
			return { kind: "extension_unavailable", cause: ftsLoadError };
		}
	}
	if (!ftsAvailable) return { kind: "extension_unavailable", cause: ftsLoadError };

	const sample = await db.queryGet<{ n: number }>(`SELECT COUNT(*) AS n FROM current_chunks`);
	const chunkCount = sample ? Number(sample.n) : 0;
	if (chunkCount === 0) return { kind: "no_chunks" };

	try {
		// FTS over current_chunks (a view) requires materializing into a table.
		// Drop & recreate the materialized projection on each rebuild.
		await db.exec(`DROP TABLE IF EXISTS _current_chunks_fts`);
		await db.exec(
			`CREATE TABLE _current_chunks_fts AS
			 SELECT (logical_path || '::' || CAST(version_id AS VARCHAR) || '::' || chunk_index) AS row_key,
			        logical_path, CAST(version_id AS VARCHAR) AS version_id, chunk_index,
			        chunk_content, search_text
			 FROM current_chunks`,
		);
		await db.exec(
			`PRAGMA create_fts_index('_current_chunks_fts', 'row_key', 'search_text', stemmer='porter', overwrite=1)`,
		);
		await db.exec(`CHECKPOINT`);
		return { kind: "rebuilt", chunk_count: chunkCount };
	} catch (e) {
		return { kind: "rebuild_failed", cause: errorMessage(e) };
	}
}

function errorMessage(e: unknown): string {
	if (e instanceof Error) return e.message;
	return String(e);
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
	ftsLoadError = undefined;
}
