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
import { logger } from "../../src/output/logger.ts";
import type { Progress } from "../../src/output/progress.ts";

interface RecordedProgress extends Progress {
	starts: Array<{ total: number; label?: string }>;
	ticks: string[];
	labels: string[];
	updates: string[];
	entries: string[];
	dones: Array<string | undefined>;
}

function recordingProgress(): RecordedProgress {
	const starts: RecordedProgress["starts"] = [];
	const ticks: string[] = [];
	const labels: string[] = [];
	const updates: string[] = [];
	const entries: string[] = [];
	const dones: Array<string | undefined> = [];
	return {
		starts,
		ticks,
		labels,
		updates,
		entries,
		dones,
		start(total, label) {
			starts.push({ total, label });
		},
		tick(label) {
			ticks.push(label);
		},
		setLabel(label) {
			labels.push(label);
		},
		update(suffix) {
			updates.push(suffix);
		},
		setWorkers() {},
		workerSet() {},
		addChunks() {},
		entry(line) {
			entries.push(line);
		},
		done(summary) {
			dones.push(summary);
		},
		fail() {},
		info() {},
	};
}

let tmp: string;
let docsDir: string;
let ctx: AppContext;
let recorder: RecordedProgress;

describe("add progress reporting", () => {
	beforeAll(async () => {
		tmp = realpathSync(mkdtempSync(join(tmpdir(), "membot-add-progress-")));
		docsDir = join(tmp, "docs");
		mkdirSync(docsDir);
		writeFileSync(join(docsDir, "a.md"), "# A\n\nfirst doc.");
		writeFileSync(join(docsDir, "b.md"), "# B\n\nsecond doc.");
		writeFileSync(join(docsDir, "c.md"), "# C\n\nthird doc.");

		setEmbeddingCacheDir(join(tmp, "models"));
		const config = MembotConfigSchema.parse({ data_dir: tmp });
		const db = await openDb(join(tmp, "index.duckdb"));
		recorder = recordingProgress();
		ctx = {
			config,
			dataDir: tmp,
			configPath: join(tmp, "config.json"),
			db,
			logger,
			progress: recorder,
		};
	}, 120_000);

	afterAll(async () => {
		await closeContext(ctx);
		rmSync(tmp, { recursive: true, force: true });
	});

	test("multi-source add starts progress once with the correct total and emits one entry per file", async () => {
		const sources = [join(docsDir, "a.md"), join(docsDir, "b.md"), join(docsDir, "c.md")];
		recorder.starts.length = 0;
		recorder.ticks.length = 0;
		recorder.entries.length = 0;
		recorder.dones.length = 0;

		const result = await addOperation.handler({ sources, follow_symlinks: true, force: false }, ctx);

		expect(recorder.starts.length).toBe(1);
		expect(recorder.starts[0]?.total).toBe(3);

		expect(recorder.ticks.length).toBe(3);
		expect(recorder.entries.length).toBe(3);

		// Each entry line should mention the logical_path (or source_path on failure).
		const ingestedPaths = result.ingested.map((e) => e.logical_path);
		for (const p of ingestedPaths) {
			expect(recorder.entries.some((line) => line.includes(p))).toBe(true);
		}

		expect(recorder.dones.length).toBe(1);
		expect(recorder.dones[0]).toContain(`added ${result.ok}/${result.total}`);
	}, 180_000);

	test("a bad-path source becomes a per-source failure entry without aborting the batch", async () => {
		const sources = [join(docsDir, "a.md"), join(tmp, "nope-does-not-exist.md"), join(docsDir, "b.md")];
		recorder.starts.length = 0;
		recorder.ticks.length = 0;
		recorder.entries.length = 0;
		recorder.dones.length = 0;

		const result = await addOperation.handler({ sources, follow_symlinks: true, force: false }, ctx);

		expect(recorder.starts.length).toBe(1);
		expect(recorder.starts[0]?.total).toBe(3);
		expect(recorder.ticks.length).toBe(3);
		expect(recorder.entries.length).toBe(3);

		expect(result.failed).toBe(1);
		expect(result.total).toBe(3);
		const failed = result.ingested.find((e) => e.status === "failed");
		expect(failed?.source_path).toContain("nope-does-not-exist.md");
		expect(failed?.error).toBeDefined();
	}, 180_000);
});
