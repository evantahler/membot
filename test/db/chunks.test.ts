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
});
