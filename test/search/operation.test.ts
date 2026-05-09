import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MembotConfigSchema } from "../../src/config/schemas.ts";
import { EMBEDDING_DIMENSION } from "../../src/constants.ts";
import type { AppContext } from "../../src/context.ts";
import { closeContext } from "../../src/context.ts";
import { _resetFtsState, insertChunksForVersion } from "../../src/db/chunks.ts";
import { openDb } from "../../src/db/connection.ts";
import { insertVersion, millisIso } from "../../src/db/files.ts";
import { HelpfulError } from "../../src/errors.ts";
import { embed, setEmbeddingCacheDir } from "../../src/ingest/embedder.ts";
import { buildSearchText } from "../../src/ingest/search-text.ts";
import { searchOperation } from "../../src/operations/search.ts";
import { logger } from "../../src/output/logger.ts";
import { createProgress } from "../../src/output/progress.ts";

interface Doc {
	logical_path: string;
	description: string;
	body: string;
}

const DOCS: Doc[] = [
	{
		logical_path: "docs/auth.md",
		description: "OAuth 2.0 authentication notes",
		body: "# Auth\n\nOAuth 2.0 authorization code flow with refresh tokens and PKCE for SPAs.",
	},
	{
		logical_path: "code/db-tuning.md",
		description: "Postgres performance tuning checklist",
		body: "# DB tuning\n\nUse EXPLAIN ANALYZE to inspect query plans, tune shared_buffers and work_mem.",
	},
	{
		logical_path: "recipes/pasta.md",
		description: "Italian pasta recipes",
		body: "# Pasta\n\nCarbonara: eggs, pecorino, guanciale, pepper.",
	},
];

let tmp: string;
let ctx: AppContext;

describe("search Operation handler", () => {
	beforeAll(async () => {
		tmp = mkdtempSync(join(tmpdir(), "membot-search-op-"));
		setEmbeddingCacheDir(join(tmp, "models"));
		_resetFtsState();

		const config = MembotConfigSchema.parse({ data_dir: tmp });
		const db = await openDb(join(tmp, "index.duckdb"));
		ctx = {
			config,
			dataDir: tmp,
			configPath: join(tmp, "config.json"),
			db,
			logger,
			progress: createProgress(),
		};

		// Ingest with real embeddings so the semantic path is exercised end-to-end.
		const searchTexts = DOCS.map((d) => buildSearchText(d.logical_path, d.description, d.body));
		const vectors = await embed(searchTexts);
		for (let i = 0; i < DOCS.length; i++) {
			const d = DOCS[i]!;
			const v = millisIso(1_700_000_000_000 + i);
			await insertVersion(db, {
				logical_path: d.logical_path,
				version_id: v,
				source_type: "inline",
				content: d.body,
				description: d.description,
				mime_type: "text/markdown",
			});
			await insertChunksForVersion(db, d.logical_path, v, [
				{
					chunk_index: 0,
					chunk_content: d.body,
					search_text: searchTexts[i]!,
					embedding: vectors[i]!,
				},
			]);
		}
	}, 120_000);

	afterAll(async () => {
		await closeContext(ctx);
		rmSync(tmp, { recursive: true, force: true });
	});

	test("mode=hybrid runs both signals; chunks matched by both float to the top", async () => {
		const r = await searchOperation.handler(
			{ query: "EXPLAIN ANALYZE", mode: "hybrid", limit: 5, include_history: false },
			ctx,
		);
		expect(r.mode).toBe("hybrid");
		expect(r.hits.length).toBeGreaterThan(0);
		const top = r.hits[0]!;
		expect(top.logical_path).toBe("code/db-tuning.md");
		// "EXPLAIN ANALYZE" hits BM25 strongly AND is semantically relevant —
		// both signals should fire on the top hit.
		expect(top.semantic_score).not.toBeNull();
		expect(top.keyword_score).not.toBeNull();
	}, 60_000);

	test("mode=semantic skips the keyword side (keyword_score is null on every hit)", async () => {
		const r = await searchOperation.handler(
			{ query: "how do I cook pasta", mode: "semantic", limit: 5, include_history: false },
			ctx,
		);
		expect(r.mode).toBe("semantic");
		expect(r.hits.length).toBeGreaterThan(0);
		expect(r.hits[0]?.logical_path).toBe("recipes/pasta.md");
		for (const h of r.hits) expect(h.keyword_score).toBeNull();
	}, 60_000);

	test("mode=keyword skips the semantic side (semantic_score is null on every hit)", async () => {
		const r = await searchOperation.handler(
			{ query: "carbonara", mode: "keyword", limit: 5, include_history: false },
			ctx,
		);
		expect(r.mode).toBe("keyword");
		expect(r.hits.length).toBeGreaterThan(0);
		expect(r.hits[0]?.logical_path).toBe("recipes/pasta.md");
		for (const h of r.hits) expect(h.semantic_score).toBeNull();
	});

	test("normalized score is bounded in [0, 1] across every mode", async () => {
		for (const mode of ["hybrid", "semantic", "keyword"] as const) {
			const r = await searchOperation.handler({ query: "carbonara", mode, limit: 5, include_history: false }, ctx);
			for (const h of r.hits) {
				expect(h.score).toBeGreaterThanOrEqual(0);
				expect(h.score).toBeLessThanOrEqual(1);
			}
		}
	}, 60_000);

	test("respects path_prefix to scope hits to a subdirectory", async () => {
		const r = await searchOperation.handler(
			{ query: "carbonara", mode: "keyword", path_prefix: "docs/", limit: 10, include_history: false },
			ctx,
		);
		// Only "recipes/pasta.md" contains "carbonara", and it's outside the docs/ prefix.
		expect(r.hits).toEqual([]);
	});

	test("respects limit", async () => {
		// Use a token present in every doc body (markdown headers all start with #).
		const r = await searchOperation.handler({ query: "the", mode: "keyword", limit: 1, include_history: false }, ctx);
		expect(r.hits.length).toBeLessThanOrEqual(1);
	});

	test("falls back to query when only pattern is provided (and vice versa)", async () => {
		const a = await searchOperation.handler(
			{ pattern: "carbonara", mode: "keyword", limit: 5, include_history: false },
			ctx,
		);
		expect(a.hits[0]?.logical_path).toBe("recipes/pasta.md");

		const b = await searchOperation.handler(
			{ query: "carbonara", mode: "keyword", limit: 5, include_history: false },
			ctx,
		);
		expect(b.hits[0]?.logical_path).toBe("recipes/pasta.md");
	});
});

describe("search Operation handler — empty-query handling", () => {
	let tmp2: string;
	let ctx2: AppContext;

	beforeAll(async () => {
		tmp2 = mkdtempSync(join(tmpdir(), "membot-search-op-empty-"));
		_resetFtsState();
		const config = MembotConfigSchema.parse({ data_dir: tmp2 });
		const db = await openDb(join(tmp2, "index.duckdb"));
		ctx2 = {
			config,
			dataDir: tmp2,
			configPath: join(tmp2, "config.json"),
			db,
			logger,
			progress: createProgress(),
		};
		// Insert a single chunk with a dummy embedding — no embedder weights needed
		// because empty-query tests never invoke the model.
		const v = millisIso(1_700_000_000_000);
		await insertVersion(db, {
			logical_path: "p.md",
			version_id: v,
			source_type: "inline",
			content: "anything",
			description: "x",
		});
		const fake = new Array(EMBEDDING_DIMENSION).fill(0);
		fake[0] = 1;
		await insertChunksForVersion(db, "p.md", v, [
			{ chunk_index: 0, chunk_content: "anything", search_text: "p.md\n\n\nanything", embedding: fake },
		]);
	});

	afterAll(async () => {
		await closeContext(ctx2);
		rmSync(tmp2, { recursive: true, force: true });
	});

	test("empty query+pattern in any mode throws HelpfulError(input_error)", async () => {
		for (const mode of ["hybrid", "semantic", "keyword"] as const) {
			const promise = searchOperation.handler({ query: "", pattern: "", mode, limit: 5, include_history: false }, ctx2);
			await expect(promise).rejects.toBeInstanceOf(HelpfulError);
			await expect(promise).rejects.toMatchObject({ kind: "input_error" });
		}
	});

	test("whitespace-only query is treated as empty and throws HelpfulError(input_error)", async () => {
		const promise = searchOperation.handler({ query: "   ", mode: "semantic", limit: 5, include_history: false }, ctx2);
		await expect(promise).rejects.toBeInstanceOf(HelpfulError);
		await expect(promise).rejects.toMatchObject({ kind: "input_error" });
	});
});
