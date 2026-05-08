import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EMBEDDING_DIMENSION } from "../../src/constants.ts";
import { _resetFtsState, insertChunksForVersion } from "../../src/db/chunks.ts";
import type { DbConnection } from "../../src/db/connection.ts";
import { openDb } from "../../src/db/connection.ts";
import { insertVersion, millisIso } from "../../src/db/files.ts";
import { searchKeyword } from "../../src/search/keyword.ts";

function fakeEmbedding(seed: number): number[] {
	const v = new Array(EMBEDDING_DIMENSION);
	for (let i = 0; i < EMBEDDING_DIMENSION; i++) v[i] = ((seed + i) % 100) / 100;
	return v;
}

async function ingest(
	db: DbConnection,
	logical_path: string,
	chunk_content: string,
	description: string,
	seed: number,
	versionMs: number,
): Promise<void> {
	const v = millisIso(versionMs);
	await insertVersion(db, { logical_path, version_id: v, source_type: "inline", content: chunk_content, description });
	await insertChunksForVersion(db, logical_path, v, [
		{
			chunk_index: 0,
			chunk_content,
			search_text: `${logical_path}\n${description}\n\n${chunk_content}`,
			embedding: fakeEmbedding(seed),
		},
	]);
}

describe("searchKeyword", () => {
	let tmp: string;
	let db: DbConnection;

	beforeEach(async () => {
		tmp = mkdtempSync(join(tmpdir(), "membot-keyword-"));
		db = await openDb(join(tmp, "test.duckdb"));
		_resetFtsState();
	});

	afterEach(async () => {
		await db.close();
		rmSync(tmp, { recursive: true, force: true });
	});

	test("returns hits with chunk_content populated for a known token", async () => {
		await ingest(
			db,
			"docs/db.md",
			"Use EXPLAIN ANALYZE to inspect query plans",
			"DB tuning notes",
			1,
			1_700_000_000_000,
		);
		await ingest(db, "docs/auth.md", "OAuth 2.0 flow with PKCE", "auth notes", 2, 1_700_000_001_000);

		const hits = await searchKeyword(db, "EXPLAIN");
		expect(hits.length).toBe(1);
		expect(hits[0]?.logical_path).toBe("docs/db.md");
		expect(hits[0]?.chunk_content).toContain("EXPLAIN");
		expect(hits[0]?.score).toBeGreaterThan(0);
	});

	test("ranks more relevant chunks higher (BM25 > 0)", async () => {
		await ingest(
			db,
			"a.md",
			"the embedding model encodes embedding vectors using bge-small embedding weights",
			"x",
			1,
			1_700_000_000_000,
		);
		await ingest(db, "b.md", "the model encodes things", "y", 2, 1_700_000_001_000);

		const hits = await searchKeyword(db, "embedding");
		expect(hits.length).toBeGreaterThanOrEqual(1);
		expect(hits[0]?.logical_path).toBe("a.md");
	});

	test("returns [] when FTS index is empty", async () => {
		const hits = await searchKeyword(db, "anything");
		expect(hits).toEqual([]);
	});

	test("respects limit option", async () => {
		for (let i = 0; i < 5; i++) {
			await ingest(db, `doc${i}.md`, `the carbonara recipe ${i}`, "x", i + 1, 1_700_000_000_000 + i);
		}
		const hits = await searchKeyword(db, "carbonara", { limit: 2 });
		expect(hits.length).toBe(2);
	});

	test("respects pathPrefix option", async () => {
		await ingest(db, "docs/a.md", "carbonara recipe", "x", 1, 1_700_000_000_000);
		await ingest(db, "recipes/b.md", "carbonara recipe", "x", 2, 1_700_000_001_000);

		const hits = await searchKeyword(db, "carbonara", { pathPrefix: "docs/" });
		expect(hits.length).toBe(1);
		expect(hits[0]?.logical_path).toBe("docs/a.md");
	});

	test("returns chunks ordered by descending BM25 score", async () => {
		await ingest(db, "weak.md", "fox", "x", 1, 1_700_000_000_000);
		await ingest(db, "strong.md", "fox fox fox running fox in the forest fox", "x", 2, 1_700_000_001_000);

		const hits = await searchKeyword(db, "fox");
		expect(hits.length).toBe(2);
		expect(hits[0]?.logical_path).toBe("strong.md");
		expect(hits[0]?.score).toBeGreaterThan(hits[1]?.score ?? Number.POSITIVE_INFINITY);
	});
});

describe("searchKeyword + rebuildFts interaction", () => {
	let tmp: string;
	let db: DbConnection;

	beforeEach(async () => {
		tmp = mkdtempSync(join(tmpdir(), "membot-keyword-rebuild-"));
		db = await openDb(join(tmp, "test.duckdb"));
		_resetFtsState();
	});

	afterEach(async () => {
		await db.close();
		rmSync(tmp, { recursive: true, force: true });
	});

	test("calls rebuildFts on every search so freshly-inserted chunks are findable", async () => {
		// First search seeds the FTS index with one chunk.
		await ingest(db, "a.md", "carbonara recipe", "x", 1, 1_700_000_000_000);
		const first = await searchKeyword(db, "carbonara");
		expect(first.length).toBe(1);

		// A second chunk added AFTER the first FTS rebuild must be visible to
		// the next search — proves searchKeyword re-materializes rather than
		// relying on a stale snapshot.
		await ingest(db, "b.md", "carbonara variant", "x", 2, 1_700_000_001_000);
		const second = await searchKeyword(db, "carbonara");
		expect(second.length).toBe(2);
		expect(second.map((h) => h.logical_path).sort()).toEqual(["a.md", "b.md"]);
	});
});
