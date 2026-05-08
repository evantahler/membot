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
import { diffOperation } from "../../src/operations/diff.ts";
import { infoOperation } from "../../src/operations/info.ts";
import { listOperation } from "../../src/operations/list.ts";
import { moveOperation } from "../../src/operations/move.ts";
import { pruneOperation } from "../../src/operations/prune.ts";
import { readOperation } from "../../src/operations/read.ts";
import { refreshOperation } from "../../src/operations/refresh.ts";
import { removeOperation } from "../../src/operations/remove.ts";
import { searchOperation } from "../../src/operations/search.ts";
import { treeOperation } from "../../src/operations/tree.ts";
import { versionsOperation } from "../../src/operations/versions.ts";
import { writeOperation } from "../../src/operations/write.ts";
import { logger } from "../../src/output/logger.ts";
import { createProgress } from "../../src/output/progress.ts";

let tmp: string;
let docsDir: string;
let docsLogical: string;
let authPath: string;
let dbPath: string;
let pastaPath: string;
let ctx: AppContext;

function toLogical(absPath: string): string {
	return absPath.replaceAll("\\", "/").replace(/^\/+/, "");
}

describe("operations end-to-end lifecycle", () => {
	beforeAll(async () => {
		tmp = realpathSync(mkdtempSync(join(tmpdir(), "membot-ops-")));
		docsDir = join(tmp, "docs");
		mkdirSync(docsDir);
		writeFileSync(join(docsDir, "auth.md"), "# Auth\n\nOAuth 2.0 authorization code flow with PKCE.");
		writeFileSync(join(docsDir, "db.md"), "# DB\n\nUse EXPLAIN to inspect query plans, tune shared_buffers.");
		writeFileSync(join(docsDir, "pasta.md"), "# Pasta\n\nCarbonara: eggs, pecorino, guanciale.");
		docsLogical = toLogical(docsDir);
		authPath = `${docsLogical}/auth.md`;
		dbPath = `${docsLogical}/db.md`;
		pastaPath = `${docsLogical}/pasta.md`;

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

	test("add ingests a directory and writes versions for each file", async () => {
		const result = await addOperation.handler(
			{
				source: docsDir,
				include: "**/*.md",
				follow_symlinks: true,
			},
			ctx,
		);
		expect(result.total).toBe(3);
		expect(result.ok).toBe(3);
		expect(result.failed).toBe(0);
	}, 180_000);

	test("list returns the ingested paths under the absolute source path", async () => {
		const out = await listOperation.handler({ limit: 100, offset: 0 }, ctx);
		const paths = out.entries.map((e) => e.logical_path).sort();
		expect(paths).toEqual([authPath, dbPath, pastaPath].sort());
	});

	test("tree synthesises a hierarchy from logical paths", async () => {
		const out = await treeOperation.handler({ max_depth: 100, max_items: 20 }, ctx);
		interface TN {
			name: string;
			children?: TN[];
		}
		const leaves: string[] = [];
		const walk = (nodes: TN[]) => {
			for (const n of nodes) {
				if (!n.children || n.children.length === 0) leaves.push(n.name);
				else walk(n.children);
			}
		};
		walk(out.tree as TN[]);
		expect(leaves.sort()).toEqual(["auth.md", "db.md", "pasta.md"]);
	});

	test("search finds the right file by semantic query", async () => {
		const r = await searchOperation.handler(
			{ query: "OAuth login flow", mode: "hybrid", limit: 3, include_history: false },
			ctx,
		);
		expect(r.hits[0]?.logical_path).toBe(authPath);
	}, 60_000);

	test("read returns markdown surrogate by default, original bytes when bytes=true", async () => {
		const surrogate = await readOperation.handler({ logical_path: authPath, bytes: false }, ctx);
		expect(surrogate.content).toContain("OAuth");
		expect(surrogate.version_is_current).toBe(true);

		const raw = await readOperation.handler({ logical_path: authPath, bytes: true }, ctx);
		const decoded = Buffer.from(raw.bytes_base64 ?? "", "base64").toString();
		expect(decoded).toContain("# Auth");
	});

	test("info returns metadata without content", async () => {
		const info = await infoOperation.handler({ logical_path: authPath }, ctx);
		expect(info.source_type).toBe("local");
		expect(info.fetcher).toBe("local");
		expect(info.source_sha256).toMatch(/^[a-f0-9]{64}$/);
	});

	test("write inserts a new inline version that wins over the local-ingest one", async () => {
		const w = await writeOperation.handler(
			{ logical_path: authPath, content: "# Auth (updated)\n\nNew agent notes." },
			ctx,
		);
		expect(w.version_id).toMatch(/T/);
		const list = await versionsOperation.handler({ logical_path: authPath }, ctx);
		expect(list.versions.length).toBe(2);
		expect(list.versions[0]?.version_id).toBe(w.version_id);
	}, 60_000);

	test("diff between current and previous version yields a non-empty unified diff", async () => {
		const versions = await versionsOperation.handler({ logical_path: authPath }, ctx);
		const older = versions.versions[1]!.version_id;
		const d = await diffOperation.handler({ logical_path: authPath, a: older }, ctx);
		expect(d.diff).toContain("+");
		expect(d.diff).toContain("-");
	});

	test("move renames a path, tombstoning the source", async () => {
		const r = await moveOperation.handler({ from_logical_path: pastaPath, to_logical_path: "recipes/pasta.md" }, ctx);
		expect(r.new_version_id).toMatch(/T/);
		const list = await listOperation.handler({ limit: 100, offset: 0 }, ctx);
		const paths = list.entries.map((e) => e.logical_path).sort();
		expect(paths).toContain("recipes/pasta.md");
		expect(paths).not.toContain(pastaPath);
	});

	test("rm tombstones a path", async () => {
		const r = await removeOperation.handler({ logical_path: dbPath }, ctx);
		expect(r.tombstone_version_id).toMatch(/T/);
		const list = await listOperation.handler({ limit: 100, offset: 0 }, ctx);
		const paths = list.entries.map((e) => e.logical_path);
		expect(paths).not.toContain(dbPath);
	});

	test("refresh on a local file with unchanged content reports unchanged", async () => {
		const r = await refreshOperation.handler({ logical_path: "recipes/pasta.md", force: false }, ctx);
		expect(r.processed[0]?.status).toBe("unchanged");
	}, 60_000);

	test("prune --before 0s --dry-run=false drops non-current rows", async () => {
		const dry = await pruneOperation.handler({ before: "0s", dry_run: true }, ctx);
		expect(dry.removed_versions).toBeGreaterThan(0);
		const real = await pruneOperation.handler({ before: "0s", dry_run: false }, ctx);
		expect(real.removed_versions).toBeGreaterThan(0);
		// After prune, only current versions and tombstones remain
		const versions = await versionsOperation.handler({ logical_path: authPath }, ctx);
		expect(versions.versions.length).toBe(1);
	});
});
