import type { Migration } from "../migrations.ts";

/**
 * Replace the old mcpx-era fetcher metadata triple
 * (`fetcher_server` / `fetcher_tool` / `fetcher_args`) with a flat
 * `(downloader, downloader_args)` shape. The mcpx-driven agent fetcher
 * is gone; per-service downloaders match a URL → run a known fetch
 * (Playwright export endpoints for Google, rendered HTML for GitHub /
 * Linear, headless print-to-PDF for everything else) → return bytes
 * for the existing native converter pipeline.
 *
 * Existing rows whose `fetcher` was `'http'` or `'mcpx'` are migrated
 * to `'downloader'` with `downloader=NULL`. The mcpx-driven ones
 * become refresh-broken (the `fetcher_*` arguments that drove them no
 * longer exist) but their stored `content` is still readable; the
 * plain-HTTP ones will be re-routed through the generic-web downloader
 * the next time refresh runs. The `fetcher` enum loses both `'http'`
 * and `'mcpx'` — every remote row is `'downloader'` now, since even
 * the plain-HTTP fallback is wrapped by the generic-web downloader.
 *
 * The `current_files` view is `SELECT f.* FROM files f`, so it pins the
 * old column shape; we drop and recreate it (and the dependent
 * `current_chunks` view) around the schema change.
 */
export const MIGRATION_003: Migration = {
	id: 3,
	name: "downloader-columns",
	// DuckDB refuses DROP COLUMN when an index covers any column that comes
	// AFTER the dropped one in the schema, and it doesn't see an in-transaction
	// DROP INDEX when checking that constraint — so the index drops have to
	// commit before the ALTER block opens. They live in `preStatements` for
	// that reason. The view drops can stay inside the transaction (DuckDB does
	// honor in-transaction DROP VIEW).
	preStatements: [
		`DROP INDEX IF EXISTS files_refresh_due_idx`,
		`DROP INDEX IF EXISTS files_blob_sha256_idx`,
		`DROP INDEX IF EXISTS files_logical_path_idx`,
	],
	// Everything below runs inside one BEGIN/COMMIT so the WAL only ever sees
	// the completed post-migration shape — avoids the partial-state replay
	// crash documented in issue #54.
	statements: [
		`DROP VIEW IF EXISTS current_chunks`,
		`DROP VIEW IF EXISTS current_files`,
		`UPDATE files SET fetcher = 'downloader' WHERE fetcher IN ('http', 'mcpx')`,
		`ALTER TABLE files DROP COLUMN fetcher_server`,
		`ALTER TABLE files DROP COLUMN fetcher_tool`,
		`ALTER TABLE files DROP COLUMN fetcher_args`,
		`ALTER TABLE files ADD COLUMN downloader TEXT`,
		`ALTER TABLE files ADD COLUMN downloader_args JSON`,
		`CREATE INDEX files_logical_path_idx ON files (logical_path)`,
		`CREATE INDEX files_blob_sha256_idx ON files (blob_sha256)`,
		`CREATE INDEX files_refresh_due_idx ON files (refresh_frequency_sec, refreshed_at)`,
		`CREATE VIEW current_files AS
			SELECT f.* FROM files f
			WHERE (f.logical_path, f.version_id) IN (
				SELECT logical_path, MAX(version_id) FROM files GROUP BY logical_path
			)
				AND f.tombstone = FALSE`,
		`CREATE VIEW current_chunks AS
			SELECT c.* FROM chunks c
			JOIN current_files cf USING (logical_path, version_id)`,
	],
};
