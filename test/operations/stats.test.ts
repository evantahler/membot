import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MembotConfigSchema } from "../../src/config/schemas.ts";
import type { AppContext } from "../../src/context.ts";
import { closeContext } from "../../src/context.ts";
import { upsertBlob } from "../../src/db/blobs.ts";
import { openDb } from "../../src/db/connection.ts";
import { insertVersion, millisIso } from "../../src/db/files.ts";
import { statsOperation } from "../../src/operations/stats.ts";
import { logger } from "../../src/output/logger.ts";
import { createProgress } from "../../src/output/progress.ts";

let tmp: string;
let ctx: AppContext;

async function makeCtx(): Promise<AppContext> {
	tmp = mkdtempSync(join(tmpdir(), "membot-stats-"));
	const config = MembotConfigSchema.parse({ data_dir: tmp });
	const db = await openDb(join(tmp, "index.duckdb"));
	return {
		config,
		dataDir: tmp,
		configPath: join(tmp, "config.json"),
		db,
		logger,
		progress: createProgress(),
	};
}

describe("stats on an empty database", () => {
	beforeAll(async () => {
		ctx = await makeCtx();
	});

	afterAll(async () => {
		await closeContext(ctx);
		rmSync(tmp, { recursive: true, force: true });
	});

	test("returns zeros across the board, no errors", async () => {
		const r = await statsOperation.handler({}, ctx);
		expect(r.prefix).toBeNull();
		expect(r.db_path.endsWith("index.duckdb")).toBe(true);
		expect(r.db_size_bytes).toBeGreaterThanOrEqual(0);
		expect(r.files.current).toBe(0);
		expect(r.files.tombstoned_paths).toBe(0);
		expect(r.files.total_versions).toBe(0);
		expect(r.files.distinct_paths).toBe(0);
		expect(r.files.by_source_type).toEqual({});
		expect(r.files.by_downloader).toEqual({});
		expect(r.files.by_mime_type).toEqual({});
		expect(r.content.total_bytes).toBe(0);
		expect(r.content.total_versions_bytes).toBe(0);
		expect(r.chunks.current).toBe(0);
		expect(r.chunks.total).toBe(0);
		expect(r.blobs.count).toBe(0);
		expect(r.blobs.total_bytes).toBe(0);
		expect(r.refresh.scheduled).toBe(0);
		expect(r.refresh.due_now).toBe(0);
		expect(r.refresh.last_status).toEqual({});
	});

	test("console_formatter renders a non-empty summary on an empty DB", async () => {
		const r = await statsOperation.handler({}, ctx);
		const formatted = statsOperation.console_formatter!(r);
		expect(formatted).toContain("membot index summary");
		expect(formatted).toContain("files");
		expect(formatted).toContain("chunks");
		expect(formatted).toContain("blobs");
		expect(formatted).toContain("refresh");
	});
});

describe("stats with seeded rows", () => {
	beforeAll(async () => {
		ctx = await makeCtx();
		const base = Date.now();
		const v = (offset: number): string => millisIso(base + offset);
		// docs/a.md — local, 100B, two versions (v1 then a refresh-style v2)
		await insertVersion(ctx.db, {
			logical_path: "docs/a.md",
			version_id: v(0),
			source_type: "local",
			source_path: "/tmp/a.md",
			mime_type: "text/markdown",
			size_bytes: 100,
			fetcher: "local",
			last_refresh_status: "ok",
			refresh_frequency_sec: 3600,
			refreshed_at: millisIso(base),
		});
		await insertVersion(ctx.db, {
			logical_path: "docs/a.md",
			version_id: v(10),
			source_type: "local",
			source_path: "/tmp/a.md",
			mime_type: "text/markdown",
			size_bytes: 110,
			fetcher: "local",
			last_refresh_status: "ok",
			refresh_frequency_sec: 3600,
			refreshed_at: millisIso(base + 10),
		});
		// docs/b.md — remote via google-docs, 200B, blob-backed
		await upsertBlob(ctx.db, {
			sha256: "b".repeat(64),
			mime_type: "application/pdf",
			size_bytes: 500,
			bytes: new Uint8Array(500),
		});
		await insertVersion(ctx.db, {
			logical_path: "docs/b.md",
			version_id: v(20),
			source_type: "remote",
			source_path: "https://docs.google.com/document/d/abc/edit",
			mime_type: "text/markdown",
			size_bytes: 200,
			fetcher: "downloader",
			downloader: "google-docs",
			blob_sha256: "b".repeat(64),
			last_refresh_status: "failed",
		});
		// notes/c.md — inline, 50B
		await insertVersion(ctx.db, {
			logical_path: "notes/c.md",
			version_id: v(30),
			source_type: "inline",
			content: "hello",
			mime_type: "text/markdown",
			size_bytes: 50,
		});
		// notes/d.md — written then tombstoned
		await insertVersion(ctx.db, {
			logical_path: "notes/d.md",
			version_id: v(40),
			source_type: "inline",
			content: "old",
			mime_type: "text/markdown",
			size_bytes: 30,
		});
		await insertVersion(ctx.db, {
			logical_path: "notes/d.md",
			version_id: v(50),
			source_type: "inline",
			tombstone: true,
			content: "",
			change_note: "removed in test",
		});
	});

	afterAll(async () => {
		await closeContext(ctx);
		rmSync(tmp, { recursive: true, force: true });
	});

	test("whole-index aggregates count current files, all versions, and blobs", async () => {
		const r = await statsOperation.handler({}, ctx);
		expect(r.prefix).toBeNull();
		// current: docs/a (latest), docs/b, notes/c. notes/d is tombstoned.
		expect(r.files.current).toBe(3);
		expect(r.files.tombstoned_paths).toBe(1);
		// total_versions: a×2 + b×1 + c×1 + d×2 (d original + d tombstone) = 6
		expect(r.files.total_versions).toBe(6);
		expect(r.files.distinct_paths).toBe(4);
		expect(r.files.by_source_type).toEqual({ local: 1, remote: 1, inline: 1 });
		expect(r.files.by_downloader).toEqual({ "google-docs": 1 });
		expect(r.files.by_mime_type["text/markdown"]).toBe(3);
		// content.total_bytes: a-current(110) + b(200) + c(50) = 360
		expect(r.content.total_bytes).toBe(360);
		expect(r.content.total_versions_bytes).toBeGreaterThanOrEqual(360);
		expect(r.blobs.count).toBe(1);
		expect(r.blobs.total_bytes).toBe(500);
		expect(r.refresh.scheduled).toBe(1);
		expect(r.refresh.last_status).toEqual({ ok: 1, failed: 1 });
	});

	test("prefix narrows aggregates to the matching subtree", async () => {
		const r = await statsOperation.handler({ prefix: "docs/" }, ctx);
		expect(r.prefix).toBe("docs/");
		expect(r.files.current).toBe(2); // docs/a, docs/b
		expect(r.files.tombstoned_paths).toBe(0);
		expect(r.files.total_versions).toBe(3); // a×2 + b×1
		expect(r.files.by_source_type).toEqual({ local: 1, remote: 1 });
		expect(r.content.total_bytes).toBe(310); // 110 + 200
		expect(r.blobs.count).toBe(1);
		expect(r.blobs.total_bytes).toBe(500);
	});

	test("prefix narrows tombstone counts correctly", async () => {
		const r = await statsOperation.handler({ prefix: "notes/" }, ctx);
		expect(r.files.current).toBe(1); // notes/c
		expect(r.files.tombstoned_paths).toBe(1); // notes/d
		expect(r.files.total_versions).toBe(3); // c×1 + d×2
	});

	test("unmatched prefix returns zeros, not an error", async () => {
		const r = await statsOperation.handler({ prefix: "no-such-prefix/" }, ctx);
		expect(r.prefix).toBe("no-such-prefix/");
		expect(r.files.current).toBe(0);
		expect(r.files.tombstoned_paths).toBe(0);
		expect(r.files.total_versions).toBe(0);
		expect(r.content.total_bytes).toBe(0);
		expect(r.blobs.count).toBe(0);
	});

	test("console_formatter shows the prefix in the header when scoped", async () => {
		const r = await statsOperation.handler({ prefix: "docs/" }, ctx);
		const formatted = statsOperation.console_formatter!(r);
		expect(formatted).toContain("[prefix=docs/]");
	});
});
