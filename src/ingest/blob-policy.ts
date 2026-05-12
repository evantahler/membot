import type { BlobsConfig } from "../config/schemas.ts";

/** Why a blob's bytes were not persisted. */
export type SkipReason = "size" | "mime";

export interface BlobPolicyDecision {
	persist: boolean;
	reason: SkipReason | null;
}

/**
 * Decide whether to persist `bytes` for a blob with this mime + size, given
 * the user's config. Used by ingest at write time AND by
 * `membot prune --strip-blob-bytes` to retroactively strip rows that would
 * be skipped under the current policy. Keeping a single predicate is the
 * whole point — it guarantees fresh ingest and retroactive strip agree on
 * what counts as "skippable".
 *
 * Mime matching is prefix-glob: `video/*` matches any mime starting with
 * `video/`; a bare `*` matches everything; anything else is an exact match.
 * Size is compared inclusively against `max_size_bytes`; equal-to-threshold
 * still persists, only strictly-larger gets skipped.
 */
export function shouldPersistBlobBytes(mime: string, size: number, cfg: BlobsConfig): BlobPolicyDecision {
	if (matchesAnyMime(mime, cfg.skip_mime_types)) {
		return { persist: false, reason: "mime" };
	}
	if (cfg.max_size_bytes !== null && size > cfg.max_size_bytes) {
		return { persist: false, reason: "size" };
	}
	return { persist: true, reason: null };
}

/** Return true when `mime` matches any pattern in `patterns`. */
function matchesAnyMime(mime: string, patterns: readonly string[]): boolean {
	for (const pattern of patterns) {
		if (matchesMime(mime, pattern)) return true;
	}
	return false;
}

/** Match a single mime against a single pattern. See `shouldPersistBlobBytes` for the grammar. */
function matchesMime(mime: string, pattern: string): boolean {
	if (pattern === "*") return true;
	if (pattern.endsWith("/*")) {
		const prefix = pattern.slice(0, -1); // keep trailing slash so "video/*" → "video/"
		return mime.startsWith(prefix);
	}
	return mime === pattern;
}
