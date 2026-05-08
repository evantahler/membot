import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EMBEDDING_DIMENSION } from "../../src/constants.ts";
import {
	_resetFtsState,
	deleteChunksForVersion,
	insertChunksForVersion,
	listChunksForVersion,
	rebuildFts,
} from "../../src/db/chunks.ts";
import type { DbConnection } from "../../src/db/connection.ts";
import { openDb } from "../../src/db/connection.ts";
import { insertVersion, millisIso } from "../../src/db/files.ts";

function fakeEmbedding(seed: number): number[] {
	const v = new Array(EMBEDDING_DIMENSION);
	for (let i = 0; i < EMBEDDING_DIMENSION; i++) v[i] = ((seed + i) % 100) / 100;
	return v;
}

describe("chunks CRUD", () => {
	let tmp: string;
	let db: DbConnection;

	beforeEach(async () => {
		tmp = mkdtempSync(join(tmpdir(), "membot-chunks-"));
		db = await openDb(join(tmp, "test.duckdb"));
		_resetFtsState();
	});

	afterEach(async () => {
		await db.close();
		rmSync(tmp, { recursive: true, force: true });
	});

	test("insert + list chunks", async () => {
		const v = millisIso(1_700_000_000_000);
		await insertVersion(db, { logical_path: "p.md", version_id: v, source_type: "local", content: "x" });
		await insertChunksForVersion(db, "p.md", v, [
			{ chunk_index: 0, chunk_content: "a", search_text: "p.md\n\n\na", embedding: fakeEmbedding(1) },
			{ chunk_index: 1, chunk_content: "b", search_text: "p.md\n\n\nb", embedding: fakeEmbedding(2) },
		]);
		const chunks = await listChunksForVersion(db, "p.md", v);
		expect(chunks).toHaveLength(2);
		expect(chunks[0]?.chunk_index).toBe(0);
		expect(chunks[0]?.embedding.length).toBe(EMBEDDING_DIMENSION);
	});

	test("rejects mismatched embedding dimension", async () => {
		const v = millisIso(1_700_000_000_000);
		await insertVersion(db, { logical_path: "p.md", version_id: v, source_type: "local", content: "x" });
		expect(
			insertChunksForVersion(db, "p.md", v, [
				{ chunk_index: 0, chunk_content: "a", search_text: "a", embedding: [1, 2, 3] },
			]),
		).rejects.toThrow(/dimension/);
	});

	test("delete chunks for a version", async () => {
		const v = millisIso(1_700_000_000_000);
		await insertVersion(db, { logical_path: "p.md", version_id: v, source_type: "local", content: "x" });
		await insertChunksForVersion(db, "p.md", v, [
			{ chunk_index: 0, chunk_content: "a", search_text: "a", embedding: fakeEmbedding(1) },
		]);
		await deleteChunksForVersion(db, "p.md", v);
		const chunks = await listChunksForVersion(db, "p.md", v);
		expect(chunks).toEqual([]);
	});

	test("rebuildFts returns no_chunks on empty store", async () => {
		const result = await rebuildFts(db);
		expect(result.kind).toBe("no_chunks");
	});

	test("rebuildFts returns rebuilt with chunk_count after insert", async () => {
		const v = millisIso(1_700_000_000_000);
		await insertVersion(db, {
			logical_path: "p.md",
			version_id: v,
			source_type: "local",
			content: "x",
		});
		await insertChunksForVersion(db, "p.md", v, [
			{ chunk_index: 0, chunk_content: "a", search_text: "p.md\n\n\na", embedding: fakeEmbedding(1) },
		]);
		const result = await rebuildFts(db);
		expect(result.kind).toBe("rebuilt");
		if (result.kind === "rebuilt") expect(result.chunk_count).toBe(1);
	});

	test("rebuildFts materializes _current_chunks_fts with chunk_content column", async () => {
		// Regression: the materialized table previously omitted chunk_content,
		// which made every keyword search throw + the empty catch silently
		// returned zero hits. Locking the schema down here.
		const v = millisIso(1_700_000_000_000);
		await insertVersion(db, { logical_path: "p.md", version_id: v, source_type: "local", content: "x" });
		await insertChunksForVersion(db, "p.md", v, [
			{
				chunk_index: 0,
				chunk_content: "the quick brown fox jumps",
				search_text: "p.md\n\nfox notes\n\nthe quick brown fox jumps",
				embedding: fakeEmbedding(1),
			},
		]);
		await rebuildFts(db);

		const cols = await db.queryAll<{ column_name: string }>(
			`SELECT column_name FROM information_schema.columns WHERE table_name = '_current_chunks_fts'`,
		);
		const names = cols.map((c) => c.column_name).sort();
		expect(names).toEqual(["chunk_content", "chunk_index", "logical_path", "row_key", "search_text", "version_id"]);

		const row = await db.queryGet<{ chunk_content: string }>(`SELECT chunk_content FROM _current_chunks_fts LIMIT 1`);
		expect(row?.chunk_content).toBe("the quick brown fox jumps");
	});

	test("rebuildFts produces a working BM25 index for known tokens", async () => {
		// Direct regression for the bug class: if FTS reports 'rebuilt' but the
		// BM25 query returns zero hits on a token that's indisputably present,
		// something is broken in the materialization or PRAGMA call.
		const v = millisIso(1_700_000_000_000);
		await insertVersion(db, { logical_path: "p.md", version_id: v, source_type: "local", content: "x" });
		await insertChunksForVersion(db, "p.md", v, [
			{
				chunk_index: 0,
				chunk_content: "carbonara recipe with guanciale and pecorino",
				search_text: "p.md\n\nrecipe\n\ncarbonara recipe with guanciale and pecorino",
				embedding: fakeEmbedding(1),
			},
		]);
		const result = await rebuildFts(db);
		expect(result.kind).toBe("rebuilt");

		const hits = await db.queryAll<{ row_key: string; bm25: number }>(
			`SELECT row_key, fts_main__current_chunks_fts.match_bm25(row_key, ?1) AS bm25
			   FROM _current_chunks_fts
			  WHERE fts_main__current_chunks_fts.match_bm25(row_key, ?1) IS NOT NULL`,
			"carbonara",
		);
		expect(hits.length).toBe(1);
		expect(Number(hits[0]?.bm25)).toBeGreaterThan(0);
	});
});
