import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insertChunksForVersion, rebuildFts } from "../../src/db/chunks.ts";
import type { DbConnection } from "../../src/db/connection.ts";
import { openDb } from "../../src/db/connection.ts";
import { insertVersion, millisIso } from "../../src/db/files.ts";
import { chunkDeterministic } from "../../src/ingest/chunker.ts";
import { embed, embedSingle, setEmbeddingCacheDir } from "../../src/ingest/embedder.ts";
import { buildSearchText } from "../../src/ingest/search-text.ts";
import { fuseRRF } from "../../src/search/hybrid.ts";
import { searchKeyword } from "../../src/search/keyword.ts";
import { searchSemantic } from "../../src/search/semantic.ts";

interface Doc {
	logical_path: string;
	description: string;
	body: string;
}

const DOCS: Doc[] = [
	{
		logical_path: "docs/auth.md",
		description: "OAuth 2.0 authentication flow notes",
		body: "# Auth\n\nThis document covers OAuth 2.0 authorization code flow, refresh tokens, and PKCE for SPAs.",
	},
	{
		logical_path: "recipes/pasta.md",
		description: "Italian pasta recipes",
		body: "# Pasta\n\nCarbonara is a Roman dish with eggs, pecorino, guanciale, and black pepper. Serve immediately.",
	},
	{
		logical_path: "code/db-tuning.md",
		description: "Database performance tuning checklist",
		body: "# DB tuning\n\nIndex on the columns most-used in WHERE. Use EXPLAIN. Tune shared_buffers and work_mem for Postgres.",
	},
	{
		logical_path: "diagrams/architecture.png",
		description: "System architecture diagram showing the OAuth login flow with browser, IdP, and API server",
		body: "(image, image/png, 124000 bytes)",
	},
];

let tmp: string;
let db: DbConnection;

describe("hybrid search e2e — real embeddings, real DB", () => {
	beforeAll(async () => {
		tmp = mkdtempSync(join(tmpdir(), "membot-e2e-"));
		setEmbeddingCacheDir(join(tmp, "models"));
		db = await openDb(join(tmp, "test.duckdb"));

		// Ingest each doc fully: insert version, chunk, embed, persist chunks.
		for (let i = 0; i < DOCS.length; i++) {
			const doc = DOCS[i]!;
			const versionId = millisIso(1_700_000_000_000 + i);
			await insertVersion(db, {
				logical_path: doc.logical_path,
				version_id: versionId,
				source_type: "inline",
				content: doc.body,
				description: doc.description,
				mime_type: "text/markdown",
			});
			const chunks = chunkDeterministic(doc.body, { mode: "deterministic", target_chars: 4000, max_chars: 15000 });
			const searchTexts = chunks.map((c) => buildSearchText(doc.logical_path, doc.description, c.content));
			const vectors = await embed(searchTexts);
			await insertChunksForVersion(
				db,
				doc.logical_path,
				versionId,
				chunks.map((c, idx) => ({
					chunk_index: c.index,
					chunk_content: c.content,
					search_text: searchTexts[idx]!,
					embedding: vectors[idx]!,
				})),
			);
		}
		await rebuildFts(db);
	}, 120_000);

	afterAll(async () => {
		await db.close();
		rmSync(tmp, { recursive: true, force: true });
	});

	test("semantic: 'OAuth login flow' surfaces auth + diagram docs", async () => {
		const queryVec = await embedSingle("OAuth login flow");
		const hits = await searchSemantic(db, queryVec, { limit: 5 });
		expect(hits.length).toBeGreaterThan(0);
		const top2 = hits.slice(0, 2).map((h) => h.logical_path);
		expect(top2).toContain("docs/auth.md");
		expect(top2).toContain("diagrams/architecture.png");
	});

	test("semantic: 'how do I cook pasta?' surfaces the pasta recipe", async () => {
		const queryVec = await embedSingle("how do I cook pasta?");
		const hits = await searchSemantic(db, queryVec, { limit: 3 });
		expect(hits[0]?.logical_path).toBe("recipes/pasta.md");
	});

	test("keyword: 'EXPLAIN' surfaces the DB tuning doc when FTS is available", async () => {
		const hits = await searchKeyword(db, "EXPLAIN");
		// FTS may not load on all platforms; if so, hits will be empty and we skip.
		if (hits.length === 0) return;
		expect(hits[0]?.logical_path).toBe("code/db-tuning.md");
	});

	test("hybrid: filename / description prefix lifts recall on a pure-description query", async () => {
		const queryVec = await embedSingle("the OAuth diagram");
		const semantic = await searchSemantic(db, queryVec, { limit: 10 });
		const keyword = await searchKeyword(db, "OAuth diagram");
		const fused = fuseRRF(semantic, keyword, { limit: 5 });
		expect(fused.length).toBeGreaterThan(0);
		// The PNG row's body is just a placeholder, so this is the proof that the
		// description prefix flowing into chunks.search_text is doing its job.
		const surfaces = fused.map((f) => f.logical_path);
		expect(surfaces).toContain("diagrams/architecture.png");
	});
});
