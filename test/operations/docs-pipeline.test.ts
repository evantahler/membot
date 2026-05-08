import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MembotConfigSchema } from "../../src/config/schemas.ts";
import { type AppContext, closeContext } from "../../src/context.ts";
import { openDb } from "../../src/db/connection.ts";
import { setEmbeddingCacheDir } from "../../src/ingest/embedder.ts";
import { addOperation } from "../../src/operations/add.ts";
import { searchOperation } from "../../src/operations/search.ts";
import { versionsOperation } from "../../src/operations/versions.ts";
import { writeOperation } from "../../src/operations/write.ts";
import { logger } from "../../src/output/logger.ts";
import { createProgress } from "../../src/output/progress.ts";

// End-to-end exercise of the real ingest pipeline against the project's own
// docs/plan.md. Catches regressions in local-reader → converter → chunker →
// embedder → DB → FTS that synthetic-input tests can miss (e.g. the WASM patch
// being unapplied — the failure mode that motivated this test).
describe("docs pipeline e2e (real docs/plan.md)", () => {
	let tmp: string;
	let ctx: AppContext;

	beforeAll(async () => {
		tmp = mkdtempSync(join(tmpdir(), "membot-docs-e2e-"));
		setEmbeddingCacheDir(join(tmp, "models"));
		const config = MembotConfigSchema.parse({ data_dir: tmp });
		const db = await openDb(join(tmp, "index.duckdb"));
		ctx = {
			config,
			dataDir: tmp,
			configPath: join(tmp, "config.json"),
			db,
			logger,
			progress: createProgress(),
			mcpx: null,
		};
	}, 120_000);

	afterAll(async () => {
		await closeContext(ctx);
		rmSync(tmp, { recursive: true, force: true });
	});

	test("add → search → write new version → versions lists v1+v2", async () => {
		const planPath = resolve(import.meta.dir, "../../docs/plan.md");

		const added = await addOperation.handler({ sources: [planPath], follow_symlinks: true }, ctx);
		expect(added.ok).toBe(1);
		expect(added.failed).toBe(0);
		const v1 = added.ingested[0]?.version_id;
		const lp = added.ingested[0]?.logical_path;
		expect(v1).toBeTruthy();
		expect(lp).toBeTruthy();

		const hits = await searchOperation.handler(
			{ query: "DuckDB hybrid search vector and BM25", mode: "hybrid", limit: 5, include_history: false },
			ctx,
		);
		expect(hits.hits.length).toBeGreaterThan(0);
		expect(hits.hits.some((h) => h.logical_path === lp)).toBe(true);

		const written = await writeOperation.handler(
			{ logical_path: lp as string, content: "# updated\n\nfresh body for versioning test\n" },
			ctx,
		);
		expect(written.version_id).not.toBe(v1);

		const vs = await versionsOperation.handler({ logical_path: lp as string }, ctx);
		expect(vs.versions.length).toBeGreaterThanOrEqual(2);
		expect(vs.versions[0]?.version_id).toBe(written.version_id);
	}, 240_000);
});
