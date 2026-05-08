import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gcOrphanBlobs, readBlob, upsertBlob } from "../../src/db/blobs.ts";
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
