import type { Migration } from "../migrations.ts";

export const MIGRATION_002: Migration = {
	id: 2,
	name: "fts",
	// INSTALL/LOAD are extension-loader statements that DuckDB doesn't accept
	// inside an explicit BEGIN/COMMIT — they're idempotent and don't write the
	// schema-changing WAL entries that the transactional wrap is there to make
	// atomic, so this migration opts out.
	transactional: false,
	statements: [
		`INSTALL fts`,
		`LOAD fts`,
		// FTS index built lazily by ingest.ts / refresh.ts after the first chunk insert,
		// because PRAGMA create_fts_index errors when the table is empty in some builds.
	],
};
