import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MembotConfigSchema } from "../../src/config/schemas.ts";
import type { AppContext } from "../../src/context.ts";
import { closeContext } from "../../src/context.ts";
import { openDb } from "../../src/db/connection.ts";
import { setEmbeddingCacheDir } from "../../src/ingest/embedder.ts";
import { addOperation } from "../../src/operations/add.ts";
import { versionsOperation } from "../../src/operations/versions.ts";
import { logger } from "../../src/output/logger.ts";
import { createProgress } from "../../src/output/progress.ts";

let tmp: string;
let docsDir: string;
let aPath: string;
let bPath: string;
let ctx: AppContext;

const toLogical = (p: string) => p.replaceAll("\\", "/").replace(/^\/+/, "");

describe("add idempotency", () => {
	beforeAll(async () => {
		tmp = realpathSync(mkdtempSync(join(tmpdir(), "membot-add-idem-")));
		docsDir = join(tmp, "docs");
		mkdirSync(docsDir);
		writeFileSync(join(docsDir, "a.md"), "# A\n\nfirst doc.");
		writeFileSync(join(docsDir, "b.md"), "# B\n\nsecond doc.");
		aPath = toLogical(join(docsDir, "a.md"));
		bPath = toLogical(join(docsDir, "b.md"));

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

	test("re-adding unchanged content reports unchanged and reuses version_id", async () => {
		const first = await addOperation.handler({ sources: [docsDir], follow_symlinks: true, force: false }, ctx);
		expect(first.ok).toBe(2);
		expect(first.unchanged).toBe(0);
		const firstVersionsByPath = new Map(first.ingested.map((e) => [e.logical_path, e.version_id]));

		const second = await addOperation.handler({ sources: [docsDir], follow_symlinks: true, force: false }, ctx);
		expect(second.ok).toBe(0);
		expect(second.unchanged).toBe(2);
		expect(second.failed).toBe(0);
		for (const e of second.ingested) {
			expect(e.status).toBe("unchanged");
			expect(e.version_id).toBe(firstVersionsByPath.get(e.logical_path) ?? null);
		}

		const a = await versionsOperation.handler({ logical_path: aPath }, ctx);
		expect(a.versions.length).toBe(1);
	}, 180_000);

	test("force=true re-ingests even when source bytes are unchanged", async () => {
		const result = await addOperation.handler({ sources: [docsDir], follow_symlinks: true, force: true }, ctx);
		expect(result.ok).toBe(2);
		expect(result.unchanged).toBe(0);
		const a = await versionsOperation.handler({ logical_path: aPath }, ctx);
		expect(a.versions.length).toBe(2);
	}, 180_000);

	test("changing the source bytes creates a new version on next add", async () => {
		writeFileSync(join(docsDir, "a.md"), "# A\n\nfirst doc — revised.");
		const result = await addOperation.handler({ sources: [docsDir], follow_symlinks: true, force: false }, ctx);
		const aEntry = result.ingested.find((e) => e.logical_path === aPath);
		const bEntry = result.ingested.find((e) => e.logical_path === bPath);
		expect(aEntry?.status).toBe("ok");
		expect(bEntry?.status).toBe("unchanged");
		expect(result.ok).toBe(1);
		expect(result.unchanged).toBe(1);
		const a = await versionsOperation.handler({ logical_path: aPath }, ctx);
		expect(a.versions.length).toBe(3);
	}, 180_000);
});
