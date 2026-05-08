import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MembotConfigSchema } from "../../src/config/schemas.ts";
import type { AppContext } from "../../src/context.ts";
import { closeContext } from "../../src/context.ts";
import { openDb } from "../../src/db/connection.ts";
import { HelpfulError } from "../../src/errors.ts";
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
let ctx: AppContext;

describe("operations end-to-end lifecycle", () => {
	beforeAll(async () => {
		tmp = mkdtempSync(join(tmpdir(), "membot-ops-"));
		docsDir = join(tmp, "docs");
		mkdirSync(docsDir);
		writeFileSync(join(docsDir, "auth.md"), "# Auth\n\nOAuth 2.0 authorization code flow with PKCE.");
		writeFileSync(join(docsDir, "db.md"), "# DB\n\nUse EXPLAIN to inspect query plans, tune shared_buffers.");
		writeFileSync(join(docsDir, "pasta.md"), "# Pasta\n\nCarbonara: eggs, pecorino, guanciale.");

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
				sources: [docsDir],
				include: "**/*.md",
				follow_symlinks: true,
			},
			ctx,
		);
		expect(result.total).toBe(3);
		expect(result.ok).toBe(3);
		expect(result.failed).toBe(0);
	}, 180_000);

	test("list returns the ingested paths", async () => {
		const out = await listOperation.handler({ limit: 100, offset: 0 }, ctx);
		const paths = out.entries.map((e) => e.logical_path).sort();
		expect(paths).toEqual(["auth.md", "db.md", "pasta.md"]);
	});

	test("tree synthesises a hierarchy from logical paths", async () => {
		const out = await treeOperation.handler({ max_depth: 4 }, ctx);
		expect(out.tree.length).toBe(3);
		expect(out.tree.map((n) => n.name).sort()).toEqual(["auth.md", "db.md", "pasta.md"]);
	});

	test("search finds the right file by semantic query", async () => {
		const r = await searchOperation.handler(
			{ query: "OAuth login flow", mode: "hybrid", limit: 3, include_history: false },
			ctx,
		);
		expect(r.hits[0]?.logical_path).toBe("auth.md");
	}, 60_000);

	test("read returns markdown surrogate by default, original bytes when bytes=true", async () => {
		const surrogate = await readOperation.handler({ logical_path: "auth.md", bytes: false }, ctx);
		expect(surrogate.content).toContain("OAuth");
		expect(surrogate.version_is_current).toBe(true);

		const raw = await readOperation.handler({ logical_path: "auth.md", bytes: true }, ctx);
		const decoded = Buffer.from(raw.bytes_base64 ?? "", "base64").toString();
		// For a markdown source, bytes=true returns the ORIGINAL text — not
		// the surrogate. They happen to be the same for native markdown.
		expect(decoded).toContain("# Auth");
	});

	test("info returns metadata without content", async () => {
		const info = await infoOperation.handler({ logical_path: "auth.md" }, ctx);
		expect(info.source_type).toBe("local");
		expect(info.fetcher).toBe("local");
		expect(info.source_sha256).toMatch(/^[a-f0-9]{64}$/);
	});

	test("write inserts a new inline version that wins over the local-ingest one", async () => {
		const w = await writeOperation.handler(
			{ logical_path: "auth.md", content: "# Auth (updated)\n\nNew agent notes." },
			ctx,
		);
		expect(w.version_id).toMatch(/T/);
		const list = await versionsOperation.handler({ logical_path: "auth.md" }, ctx);
		expect(list.versions.length).toBe(2);
		expect(list.versions[0]?.version_id).toBe(w.version_id);
	}, 60_000);

	test("diff between current and previous version yields a non-empty unified diff", async () => {
		const versions = await versionsOperation.handler({ logical_path: "auth.md" }, ctx);
		const older = versions.versions[1]!.version_id;
		const d = await diffOperation.handler({ logical_path: "auth.md", a: older }, ctx);
		expect(d.diff).toContain("+");
		expect(d.diff).toContain("-");
	});

	test("move renames a path, tombstoning the source", async () => {
		const r = await moveOperation.handler({ from_logical_path: "pasta.md", to_logical_path: "recipes/pasta.md" }, ctx);
		expect(r.new_version_id).toMatch(/T/);
		const list = await listOperation.handler({ limit: 100, offset: 0 }, ctx);
		const paths = list.entries.map((e) => e.logical_path).sort();
		expect(paths).toContain("recipes/pasta.md");
		expect(paths).not.toContain("pasta.md");
	});

	test("rm tombstones a path", async () => {
		const r = await removeOperation.handler({ paths: ["db.md"] }, ctx);
		expect(r.total).toBe(1);
		expect(r.ok).toBe(1);
		expect(r.failed).toBe(0);
		expect(r.removed[0]?.logical_path).toBe("db.md");
		expect(r.removed[0]?.version_id).toMatch(/T/);
		expect(r.removed[0]?.status).toBe("ok");
		const list = await listOperation.handler({ limit: 100, offset: 0 }, ctx);
		const paths = list.entries.map((e) => e.logical_path);
		expect(paths).not.toContain("db.md");
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
		const versions = await versionsOperation.handler({ logical_path: "auth.md" }, ctx);
		expect(versions.versions.length).toBe(1);
	});
});

describe("add variadic sources", () => {
	let tmp3: string;
	let ctx3: AppContext;

	beforeAll(async () => {
		tmp3 = mkdtempSync(join(tmpdir(), "membot-add-"));
		setEmbeddingCacheDir(join(tmp3, "models"));
		const config = MembotConfigSchema.parse({ data_dir: tmp3 });
		const db = await openDb(join(tmp3, "index.duckdb"));
		ctx3 = {
			config,
			dataDir: tmp3,
			configPath: join(tmp3, "config.json"),
			db,
			logger,
			progress: createProgress(),
			mcpx: null,
		};
	}, 120_000);

	afterAll(async () => {
		await closeContext(ctx3);
		rmSync(tmp3, { recursive: true, force: true });
	});

	test("add accepts multiple positional sources in one call", async () => {
		const dir = join(tmp3, "src");
		mkdirSync(dir);
		const fileA = join(dir, "a.md");
		const fileB = join(dir, "b.md");
		writeFileSync(fileA, "# A\n\nFirst.");
		writeFileSync(fileB, "# B\n\nSecond.");
		const result = await addOperation.handler(
			{
				sources: [fileA, fileB, "inline:agent-decided to defer"],
				follow_symlinks: true,
			},
			ctx3,
		);
		expect(result.total).toBe(3);
		expect(result.ok).toBe(3);
		expect(result.failed).toBe(0);
		const paths = result.ingested.map((e) => e.logical_path).sort();
		expect(paths).toContain("a.md");
		expect(paths).toContain("b.md");
	}, 180_000);
});

describe("rm variadic + glob", () => {
	let tmp2: string;
	let ctx2: AppContext;

	beforeAll(async () => {
		tmp2 = mkdtempSync(join(tmpdir(), "membot-rm-"));
		setEmbeddingCacheDir(join(tmp2, "models"));
		const config = MembotConfigSchema.parse({ data_dir: tmp2 });
		const db = await openDb(join(tmp2, "index.duckdb"));
		ctx2 = {
			config,
			dataDir: tmp2,
			configPath: join(tmp2, "config.json"),
			db,
			logger,
			progress: createProgress(),
			mcpx: null,
		};

		await writeOperation.handler({ logical_path: "readme.md", content: "# Readme" }, ctx2);
		await writeOperation.handler({ logical_path: "docs/a.md", content: "# A" }, ctx2);
		await writeOperation.handler({ logical_path: "docs/b.md", content: "# B" }, ctx2);
		await writeOperation.handler({ logical_path: "docs/sub/c.md", content: "# C" }, ctx2);
	}, 120_000);

	afterAll(async () => {
		await closeContext(ctx2);
		rmSync(tmp2, { recursive: true, force: true });
	});

	test("rm with a glob removes every matching current file", async () => {
		const r = await removeOperation.handler({ paths: ["docs/**/*.md"] }, ctx2);
		expect(r.total).toBe(3);
		expect(r.ok).toBe(3);
		expect(r.failed).toBe(0);
		const removedPaths = r.removed.map((e) => e.logical_path).sort();
		expect(removedPaths).toEqual(["docs/a.md", "docs/b.md", "docs/sub/c.md"]);

		const list = await listOperation.handler({ limit: 100, offset: 0 }, ctx2);
		expect(list.entries.map((e) => e.logical_path)).toEqual(["readme.md"]);
	});

	test("rm accepts multiple positional args and dedupes literal+glob overlap", async () => {
		// Re-seed fresh paths after the prior glob test removed them.
		await writeOperation.handler({ logical_path: "x.md", content: "# X" }, ctx2);
		await writeOperation.handler({ logical_path: "y.md", content: "# Y" }, ctx2);
		await writeOperation.handler({ logical_path: "z.md", content: "# Z" }, ctx2);

		// "x.md" is a literal match; "*.md" is a glob that ALSO matches it.
		// The dedup should mean x.md is tombstoned exactly once.
		const r = await removeOperation.handler({ paths: ["x.md", "*.md"] }, ctx2);
		// Matches: readme.md + x.md + y.md + z.md (4 unique current paths)
		expect(r.total).toBe(4);
		expect(r.ok).toBe(4);
		const counts = new Map<string, number>();
		for (const e of r.removed) counts.set(e.logical_path, (counts.get(e.logical_path) ?? 0) + 1);
		expect(counts.get("x.md")).toBe(1);
	});

	test("rm with a glob that matches nothing throws HelpfulError(not_found)", async () => {
		try {
			await removeOperation.handler({ paths: ["does/not/exist/**"] }, ctx2);
			throw new Error("expected throw");
		} catch (err) {
			expect(err).toBeInstanceOf(HelpfulError);
			const helpful = err as HelpfulError;
			expect(helpful.kind).toBe("not_found");
			expect(helpful.hint).toContain("membot ls");
		}
	});

	test("rm with a literal that doesn't exist throws HelpfulError(not_found)", async () => {
		await writeOperation.handler({ logical_path: "still-here.md", content: "# H" }, ctx2);
		try {
			await removeOperation.handler({ paths: ["nope.md"] }, ctx2);
			throw new Error("expected throw");
		} catch (err) {
			expect(err).toBeInstanceOf(HelpfulError);
			expect((err as HelpfulError).kind).toBe("not_found");
		}
	});
});
