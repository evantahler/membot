import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gcOrphanBlobs, listBlobsWithBytes, readBlob, stripBlobBytes, upsertBlob } from "../../src/db/blobs.ts";
import type { DbConnection } from "../../src/db/connection.ts";
import { openDb } from "../../src/db/connection.ts";
import { insertVersion } from "../../src/db/files.ts";

describe("blobs CRUD", () => {
	let tmp: string;
	let db: DbConnection;

	beforeEach(async () => {
		tmp = mkdtempSync(join(tmpdir(), "membot-blobs-"));
		db = await openDb(join(tmp, "test.duckdb"));
	});

	afterEach(async () => {
		await db.close();
		rmSync(tmp, { recursive: true, force: true });
	});

	test("upsert + read roundtrip", async () => {
		const bytes = new TextEncoder().encode("hello world");
		await upsertBlob(db, { sha256: "deadbeef", mime_type: "text/plain", size_bytes: bytes.byteLength, bytes });
		const got = await readBlob(db, "deadbeef");
		expect(got).not.toBeNull();
		expect(new TextDecoder().decode(got?.bytes)).toBe("hello world");
		expect(got?.mime_type).toBe("text/plain");
	});

	test("upsert is no-op for existing sha", async () => {
		const a = new TextEncoder().encode("a");
		await upsertBlob(db, { sha256: "x", mime_type: "text/plain", size_bytes: 1, bytes: a });
		const b = new TextEncoder().encode("DIFFERENT");
		await upsertBlob(db, { sha256: "x", mime_type: "text/plain", size_bytes: 9, bytes: b });
		const got = await readBlob(db, "x");
		expect(new TextDecoder().decode(got?.bytes)).toBe("a"); // first write wins
	});

	test("readBlob returns null for missing sha", async () => {
		expect(await readBlob(db, "nope")).toBeNull();
	});

	test("upsert with bytes=null inserts row without bytes", async () => {
		await upsertBlob(db, {
			sha256: "skipped",
			mime_type: "video/quicktime",
			size_bytes: 100_000_000,
			bytes: null,
		});
		const got = await readBlob(db, "skipped");
		expect(got).not.toBeNull();
		expect(got?.bytes).toBeNull();
		expect(got?.mime_type).toBe("video/quicktime");
		expect(got?.size_bytes).toBe(100_000_000);
	});

	test("listBlobsWithBytes excludes rows with null bytes", async () => {
		await upsertBlob(db, { sha256: "has", mime_type: "text/plain", size_bytes: 1, bytes: new Uint8Array([97]) });
		await upsertBlob(db, { sha256: "skip", mime_type: "video/mp4", size_bytes: 999, bytes: null });
		const list = await listBlobsWithBytes(db);
		expect(list.map((r) => r.sha256).sort()).toEqual(["has"]);
	});

	test("stripBlobBytes nulls bytes and reports reclaimed bytes", async () => {
		const big = new Uint8Array(2048).fill(0x41);
		await upsertBlob(db, { sha256: "a", mime_type: "video/mp4", size_bytes: big.byteLength, bytes: big });
		await upsertBlob(db, {
			sha256: "b",
			mime_type: "text/plain",
			size_bytes: 1,
			bytes: new Uint8Array([97]),
		});
		const result = await stripBlobBytes(db, ["a"]);
		expect(result.stripped).toBe(1);
		expect(result.reclaimed_bytes).toBe(2048);
		expect((await readBlob(db, "a"))?.bytes).toBeNull();
		expect((await readBlob(db, "b"))?.bytes).not.toBeNull();
	});

	test("stripBlobBytes with empty list is a no-op", async () => {
		const result = await stripBlobBytes(db, []);
		expect(result.stripped).toBe(0);
		expect(result.reclaimed_bytes).toBe(0);
	});

	test("stripBlobBytes is idempotent — second call reports 0", async () => {
		const big = new Uint8Array(1024).fill(0x42);
		await upsertBlob(db, { sha256: "v", mime_type: "video/mp4", size_bytes: big.byteLength, bytes: big });
		await stripBlobBytes(db, ["v"]);
		const second = await stripBlobBytes(db, ["v"]);
		expect(second.stripped).toBe(0);
		expect(second.reclaimed_bytes).toBe(0);
	});

	test("gcOrphanBlobs drops blobs with no referencing file", async () => {
		const used = new TextEncoder().encode("u");
		const orphan = new TextEncoder().encode("o");
		await upsertBlob(db, { sha256: "USED", mime_type: "text/plain", size_bytes: 1, bytes: used });
		await upsertBlob(db, { sha256: "ORPHAN", mime_type: "text/plain", size_bytes: 1, bytes: orphan });
		await insertVersion(db, {
			logical_path: "p.md",
			source_type: "local",
			content: "u",
			blob_sha256: "USED",
		});
		const result = await gcOrphanBlobs(db);
		expect(result.removed).toBe(1);
		expect(await readBlob(db, "USED")).not.toBeNull();
		expect(await readBlob(db, "ORPHAN")).toBeNull();
	});
});
