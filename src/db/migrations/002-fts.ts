import type { Migration } from "../migrations.ts";

export const MIGRATION_002: Migration = {
	id: 2,
	name: "fts",
	statements: [
		`INSTALL fts`,
		`LOAD fts`,
		// FTS index built lazily by ingest.ts / refresh.ts after the first chunk insert,
		// because PRAGMA create_fts_index errors when the table is empty in some builds.
	],
};
