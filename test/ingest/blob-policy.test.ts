import { describe, expect, test } from "bun:test";
import type { BlobsConfig } from "../../src/config/schemas.ts";
import { shouldPersistBlobBytes } from "../../src/ingest/blob-policy.ts";

const cfg = (overrides: Partial<BlobsConfig> = {}): BlobsConfig => ({
	max_size_bytes: 25 * 1024 * 1024,
	skip_mime_types: ["video/*", "audio/*"],
	...overrides,
});

describe("shouldPersistBlobBytes", () => {
	test("persists a small text file", () => {
		const r = shouldPersistBlobBytes("text/markdown", 1024, cfg());
		expect(r).toEqual({ persist: true, reason: null });
	});

	test("skips by size when over max_size_bytes", () => {
		const r = shouldPersistBlobBytes("application/pdf", 30 * 1024 * 1024, cfg());
		expect(r).toEqual({ persist: false, reason: "size" });
	});

	test("size threshold is exclusive — equal-to-threshold persists", () => {
		const r = shouldPersistBlobBytes("application/pdf", 25 * 1024 * 1024, cfg());
		expect(r.persist).toBe(true);
	});

	test("skips by mime when video/* matches", () => {
		const r = shouldPersistBlobBytes("video/quicktime", 100, cfg());
		expect(r).toEqual({ persist: false, reason: "mime" });
	});

	test("skips by mime when audio/* matches even under size limit", () => {
		const r = shouldPersistBlobBytes("audio/mpeg", 1024, cfg());
		expect(r).toEqual({ persist: false, reason: "mime" });
	});

	test("mime check wins over size — large video skipped with reason=mime", () => {
		const r = shouldPersistBlobBytes("video/mp4", 50 * 1024 * 1024, cfg());
		expect(r.reason).toBe("mime");
	});

	test("exact mime match (no glob) works", () => {
		const r = shouldPersistBlobBytes("application/x-tar", 100, cfg({ skip_mime_types: ["application/x-tar"] }));
		expect(r).toEqual({ persist: false, reason: "mime" });
	});

	test("bare * pattern matches everything", () => {
		const r = shouldPersistBlobBytes("text/plain", 100, cfg({ skip_mime_types: ["*"] }));
		expect(r).toEqual({ persist: false, reason: "mime" });
	});

	test("null max_size_bytes disables size check", () => {
		const r = shouldPersistBlobBytes("application/pdf", 1024 * 1024 * 1024, cfg({ max_size_bytes: null }));
		expect(r.persist).toBe(true);
	});

	test("empty skip_mime_types disables mime check", () => {
		const r = shouldPersistBlobBytes("video/mp4", 1024, cfg({ skip_mime_types: [] }));
		expect(r.persist).toBe(true);
	});

	test("prefix glob does not over-match — 'video/*' does not match 'videoXY'", () => {
		const r = shouldPersistBlobBytes("videoXY", 100, cfg());
		expect(r.persist).toBe(true);
	});
});
