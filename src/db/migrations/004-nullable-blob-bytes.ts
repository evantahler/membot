import type { Migration } from "../migrations.ts";

/**
 * Make `blobs.bytes` nullable. Ingest can now decide to skip persisting
 * the original bytes for large or opaque artifacts (config keys
 * `blobs.max_size_bytes` and `blobs.skip_mime_types`) while still
 * inserting the rest of the row — sha256, mime, size, and downloader
 * provenance keep dedupe, refresh, and conversion-at-ingest-time working.
 * No backfill happens here; existing rows keep their bytes until
 * `membot prune --strip-blob-bytes` runs.
 */
export const MIGRATION_004: Migration = {
	id: 4,
	name: "nullable-blob-bytes",
	statements: [`ALTER TABLE blobs ALTER COLUMN bytes DROP NOT NULL`],
};
