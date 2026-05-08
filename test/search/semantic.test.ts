import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EMBEDDING_DIMENSION } from "../../src/constants.ts";
import { _resetFtsState, insertChunksForVersion } from "../../src/db/chunks.ts";
import type { DbConnection } from "../../src/db/connection.ts";
import { openDb } from "../../src/db/connection.ts";
import { insertVersion, millisIso, tombstone } from "../../src/db/files.ts";
import { searchSemantic } from "../../src/search/semantic.ts";

/**
 * Build a unit-norm vector pointing along a single basis dimension. Cosine
 * similarity between two basis vectors is 1.0 if `axis` matches, 0.0 otherwise.
 * Lets us reason precisely about ranking without invoking the embedding model.
 */
function basisVec(axis: number): number[] {
	const v = new Array(EMBEDDING_DIMENSION).fill(0);
	v[axis % EMBEDDING_DIMENSION] = 1;
	return v;
}

/** Convex blend of two basis vectors, then renormalize. */
function mixVec(axis1: number, axis2: number, weight1: number): number[] {
	const v = new Array(EMBEDDING_DIMENSION).fill(0);
	v[axis1 % EMBEDDING_DIMENSION] = weight1;
	v[axis2 % EMBEDDING_DIMENSION] = 1 - weight1;
	const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
	return v.map((x) => x / norm);
}

async function ingestVersion(
	db: DbConnection,
	logical_path: string,
	versionMs: number,
	chunk_content: string,
	embedding: number[],
): Promise<string> {
	const v = millisIso(versionMs);
	await insertVersion(db, {
		logical_path,
		version_id: v,
		source_type: "inline",
		content: chunk_content,
		description: "x",
	});
	await insertChunksForVersion(db, logical_path, v, [
		{
			chunk_index: 0,
			chunk_content,
			search_text: `${logical_path}\n\n\n${chunk_content}`,
			embedding,
		},
	]);
	return v;
}

describe("searchSemantic", () => {
	let tmp: string;
	let db: DbConnection;

	beforeEach(async () => {
		tmp = mkdtempSync(join(tmpdir(), "membot-semantic-"));
		db = await openDb(join(tmp, "test.duckdb"));
		_resetFtsState();
	});

	afterEach(async () => {
		await db.close();
		rmSync(tmp, { recursive: true, force: true });
	});

	test("orders results by descending cosine similarity (score = 1 - distance)", async () => {
		await ingestVersion(db, "exact.md", 1_700_000_000_000, "axis-0 doc", basisVec(0));
		await ingestVersion(db, "near.md", 1_700_000_001_000, "70% axis-0", mixVec(0, 1, 0.7));
		await ingestVersion(db, "far.md", 1_700_000_002_000, "axis-1 doc", basisVec(1));

		const hits = await searchSemantic(db, basisVec(0), { limit: 5 });
		expect(hits.map((h) => h.logical_path)).toEqual(["exact.md", "near.md", "far.md"]);
		expect(hits[0]?.score).toBeCloseTo(1, 5);
		expect(hits[2]?.score).toBeCloseTo(0, 5);
		// Monotonically decreasing.
		for (let i = 1; i < hits.length; i++) {
			expect(hits[i - 1]!.score).toBeGreaterThanOrEqual(hits[i]!.score);
		}
	});

	test("respects limit option", async () => {
		for (let i = 0; i < 5; i++) {
			await ingestVersion(db, `doc${i}.md`, 1_700_000_000_000 + i, `doc ${i}`, basisVec(i));
		}
		const hits = await searchSemantic(db, basisVec(0), { limit: 2 });
		expect(hits.length).toBe(2);
	});

	test("respects pathPrefix option", async () => {
		await ingestVersion(db, "docs/a.md", 1_700_000_000_000, "doc a", basisVec(0));
		await ingestVersion(db, "recipes/b.md", 1_700_000_001_000, "recipe b", basisVec(0));
		await ingestVersion(db, "docs/c.md", 1_700_000_002_000, "doc c", basisVec(0));

		const hits = await searchSemantic(db, basisVec(0), { pathPrefix: "docs/" });
		const paths = hits.map((h) => h.logical_path).sort();
		expect(paths).toEqual(["docs/a.md", "docs/c.md"]);
	});

	test("includeHistory=false (default) returns only the current version", async () => {
		// Two versions of the same logical path. Latest (v2) becomes current.
		await ingestVersion(db, "p.md", 1_700_000_000_000, "old body", basisVec(0));
		await ingestVersion(db, "p.md", 1_700_000_001_000, "new body", basisVec(0));

		const hits = await searchSemantic(db, basisVec(0), { limit: 10 });
		expect(hits.length).toBe(1);
		expect(hits[0]?.chunk_content).toBe("new body");
	});

	test("includeHistory=true returns every version", async () => {
		await ingestVersion(db, "p.md", 1_700_000_000_000, "old body", basisVec(0));
		await ingestVersion(db, "p.md", 1_700_000_001_000, "new body", basisVec(0));

		const hits = await searchSemantic(db, basisVec(0), { limit: 10, includeHistory: true });
		expect(hits.length).toBe(2);
		const bodies = hits.map((h) => h.chunk_content).sort();
		expect(bodies).toEqual(["new body", "old body"]);
	});

	test("excludes tombstoned versions from current_chunks (default)", async () => {
		await ingestVersion(db, "p.md", 1_700_000_000_000, "doomed body", basisVec(0));
		await tombstone(db, "p.md");

		const currentHits = await searchSemantic(db, basisVec(0), { limit: 10 });
		expect(currentHits).toEqual([]);

		// But it remains visible when searching history.
		const histHits = await searchSemantic(db, basisVec(0), { limit: 10, includeHistory: true });
		expect(histHits.length).toBeGreaterThanOrEqual(1);
	});

	test("returns empty array on empty store", async () => {
		const hits = await searchSemantic(db, basisVec(0));
		expect(hits).toEqual([]);
	});

	test("populates chunk_content and search_text in hits so callers can render snippets", async () => {
		await ingestVersion(db, "p.md", 1_700_000_000_000, "snippet body", basisVec(0));
		const hits = await searchSemantic(db, basisVec(0));
		expect(hits[0]?.chunk_content).toBe("snippet body");
		expect(hits[0]?.search_text).toBe("p.md\n\n\nsnippet body");
	});
});
