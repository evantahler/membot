import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EMBEDDING_REVISION } from "../../src/constants.ts";
import type { DbConnection } from "../../src/db/connection.ts";
import { openDb } from "../../src/db/connection.ts";
import {
	_resetStaleEmbeddingWarning,
	getMeta,
	META_EMBEDDING_REVISION,
	setMeta,
	warnIfStaleEmbeddingRevision,
} from "../../src/db/meta.ts";

describe("meta table", () => {
	let tmp: string;
	let db: DbConnection;

	beforeEach(async () => {
		tmp = mkdtempSync(join(tmpdir(), "membot-meta-"));
		db = await openDb(join(tmp, "test.duckdb"));
		_resetStaleEmbeddingWarning();
	});

	afterEach(async () => {
		await db.close();
		rmSync(tmp, { recursive: true, force: true });
	});

	test("a fresh DB is seeded at the current embedding revision", async () => {
		// Migration 006 seeds '2' when the chunks table is empty — fresh stores
		// never see the stale warning.
		expect(await getMeta(db, META_EMBEDDING_REVISION)).toBe(String(EMBEDDING_REVISION));
		expect(await warnIfStaleEmbeddingRevision(db)).toBe(false);
	});

	test("getMeta returns null for unknown keys", async () => {
		expect(await getMeta(db, "no-such-key")).toBeNull();
	});

	test("setMeta upserts", async () => {
		await setMeta(db, "k", "v1");
		expect(await getMeta(db, "k")).toBe("v1");
		await setMeta(db, "k", "v2");
		expect(await getMeta(db, "k")).toBe("v2");
	});

	test("warnIfStaleEmbeddingRevision detects an old revision", async () => {
		await setMeta(db, META_EMBEDDING_REVISION, "1");
		expect(await warnIfStaleEmbeddingRevision(db)).toBe(true);
		// Still stale on a second call (the warning only renders once, but the
		// boolean keeps reporting the truth).
		expect(await warnIfStaleEmbeddingRevision(db)).toBe(true);
		await setMeta(db, META_EMBEDDING_REVISION, String(EMBEDDING_REVISION));
		expect(await warnIfStaleEmbeddingRevision(db)).toBe(false);
	});
});
