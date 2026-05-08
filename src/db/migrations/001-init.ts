import { EMBEDDING_DIMENSION } from "../../constants.ts";
import type { Migration } from "../migrations.ts";

export const MIGRATION_001: Migration = {
	id: 1,
	name: "init",
	statements: [
		`CREATE TABLE blobs (
			sha256     TEXT PRIMARY KEY,
			mime_type  TEXT NOT NULL,
			size_bytes BIGINT NOT NULL,
			bytes      BLOB NOT NULL,
			created_at TIMESTAMP NOT NULL DEFAULT now()
		)`,
		`CREATE TABLE files (
			logical_path    TEXT NOT NULL,
			version_id      TIMESTAMP NOT NULL DEFAULT now(),
			tombstone       BOOLEAN NOT NULL DEFAULT FALSE,
			source_type     TEXT NOT NULL,
			source_path     TEXT,
			source_mtime_ms BIGINT,
			source_sha256   TEXT,
			blob_sha256     TEXT,
			content_sha256  TEXT,
			content         TEXT,
			description     TEXT,
			mime_type       TEXT,
			size_bytes      BIGINT,
			fetcher         TEXT,
			fetcher_server  TEXT,
			fetcher_tool    TEXT,
			fetcher_args    JSON,
			refresh_frequency_sec INTEGER,
			refreshed_at    TIMESTAMP,
			last_refresh_status TEXT,
			change_note     TEXT,
			created_at      TIMESTAMP NOT NULL DEFAULT now(),
			PRIMARY KEY (logical_path, version_id)
		)`,
		`CREATE INDEX files_logical_path_idx ON files (logical_path)`,
		`CREATE INDEX files_blob_sha256_idx ON files (blob_sha256)`,
		`CREATE INDEX files_refresh_due_idx ON files (refresh_frequency_sec, refreshed_at)`,
		`CREATE TABLE chunks (
			logical_path   TEXT NOT NULL,
			version_id     TIMESTAMP NOT NULL,
			chunk_index    INTEGER NOT NULL,
			chunk_content  TEXT NOT NULL,
			search_text    TEXT NOT NULL,
			embedding      FLOAT[${EMBEDDING_DIMENSION}] NOT NULL,
			PRIMARY KEY (logical_path, version_id, chunk_index)
		)`,
		`CREATE INDEX chunks_path_idx ON chunks (logical_path)`,
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
