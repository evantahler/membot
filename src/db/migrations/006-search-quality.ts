import type { Migration } from "../migrations.ts";

/**
 * Search-quality upgrade support.
 *
 * 1. `meta` — a tiny key/value table for store-level facts that aren't rows
 *    (currently just `embedding_revision`).
 * 2. Seed `embedding_revision`: DBs that already hold chunks were embedded
 *    under revision 1 (mean pooling, 4000/15000-char chunks); their vectors
 *    are incomparable with what current code produces, so search warns until
 *    `membot reindex --embeddings` re-embeds them. Fresh DBs start at the
 *    current revision (2) and never see the warning.
 * 3. `chunks.context` — the heading breadcrumb scoping each chunk, persisted
 *    so operations that re-derive `search_text` from stored chunks (move)
 *    can rebuild it without re-running the chunker. Existing rows get NULL,
 *    which is accurate: they were chunked without breadcrumbs.
 */
export const MIGRATION_006: Migration = {
	id: 6,
	name: "search-quality",
	statements: [
		`CREATE TABLE meta (
			key        TEXT PRIMARY KEY,
			value      TEXT NOT NULL,
			updated_at TIMESTAMP NOT NULL DEFAULT now()
		)`,
		`INSERT INTO meta (key, value)
			SELECT 'embedding_revision', CASE WHEN EXISTS (SELECT 1 FROM chunks) THEN '1' ELSE '2' END`,
		`ALTER TABLE chunks ADD COLUMN context TEXT`,
	],
};
