import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MembotConfigSchema } from "../../src/config/schemas.ts";
import type { AppContext } from "../../src/context.ts";
import { closeContext } from "../../src/context.ts";
import { upsertBlob } from "../../src/db/blobs.ts";
import { openDb } from "../../src/db/connection.ts";
import { HelpfulError } from "../../src/errors.ts";
import { setEmbeddingCacheDir } from "../../src/ingest/embedder.ts";
import { addOperation } from "../../src/operations/add.ts";
import { pruneOperation } from "../../src/operations/prune.ts";
import { readOperation } from "../../src/operations/read.ts";
import { logger } from "../../src/output/logger.ts";
import { createProgress } from "../../src/output/progress.ts";

function toLogical(absPath: string): string {
	return absPath.replaceAll("\\", "/").replace(/^\/+/, "");
}

describe("blob-skip ingest + read + retroactive strip", () => {
	let tmp: string;
	let bigFile: string;
	let bigPath: string;
	let ctx: AppContext;

	beforeAll(async () => {
		tmp = realpathSync(mkdtempSync(join(tmpdir(), "membot-blob-skip-")));
		const docsDir = join(tmp, "docs");
		mkdirSync(docsDir);
		// 4 KB of repeating text — easily over a 100-byte skip threshold but
		// small enough that the markdown surrogate / chunks / embedding all run.
		bigFile = join(docsDir, "big.md");
		writeFileSync(bigFile, "lorem ipsum dolor sit amet ".repeat(200));
		bigPath = toLogical(bigFile);

		setEmbeddingCacheDir(join(tmp, "models"));
		const config = MembotConfigSchema.parse({
			data_dir: tmp,
			blobs: { max_size_bytes: 100, skip_mime_types: [] },
		});
		const db = await openDb(join(tmp, "index.duckdb"));
		ctx = {
			config,
			dataDir: tmp,
			configPath: join(tmp, "config.json"),
			db,
			logger,
			progress: createProgress(),
		};
	}, 120_000);

	afterAll(async () => {
		await closeContext(ctx);
		rmSync(tmp, { recursive: true, force: true });
	});

	test("ingest of an oversized file persists metadata but not bytes", async () => {
		const result = await addOperation.handler({ sources: [bigFile], follow_symlinks: true }, ctx);
		expect(result.ok).toBe(1);

		const row = await ctx.db.queryGet<{ sha256: string; mime_type: string; size_bytes: number; has_bytes: boolean }>(
			`SELECT b.sha256, b.mime_type, b.size_bytes, b.bytes IS NOT NULL AS has_bytes
			 FROM blobs b JOIN current_files cf ON cf.blob_sha256 = b.sha256
			 WHERE cf.logical_path = ?1`,
			bigPath,
		);
		expect(row).not.toBeNull();
		expect(row?.has_bytes).toBe(false);
		expect(Number(row?.size_bytes)).toBeGreaterThan(100);
	}, 180_000);

	test("meta-only read reports bytes_skipped=true and blob_available=false", async () => {
		const out = await readOperation.handler({ logical_path: bigPath, bytes: false, raw: false }, ctx);
		expect(out.bytes_skipped).toBe(true);
		expect(out.blob_available).toBe(false);
		// Surrogate content (the markdown body) is still readable
		expect(out.content?.length ?? 0).toBeGreaterThan(0);
	});

	test("read bytes=true on a skipped blob throws HelpfulError pointing at config", async () => {
		try {
			await readOperation.handler({ logical_path: bigPath, bytes: true, raw: false }, ctx);
			throw new Error("expected throw");
		} catch (err) {
			expect(err).toBeInstanceOf(HelpfulError);
			const helpful = err as HelpfulError;
			expect(helpful.message).toMatch(/were not persisted/);
			expect(helpful.hint).toMatch(/blobs\.max_size_bytes|blobs\.skip_mime_types/);
		}
	});

	test("prune --strip-blob-bytes dry-run reports candidates without changing rows", async () => {
		// Seed a row whose bytes are still present and whose mime now matches
		// the policy. Use a fresh sha so we don't collide with anything ingest
		// already inserted.
		const bytes = new Uint8Array(2048).fill(0x41);
		await upsertBlob(ctx.db, { sha256: "strip-target", mime_type: "video/mp4", size_bytes: bytes.byteLength, bytes });
		// Reconfigure ctx to put video/* on the skip list so this blob qualifies.
		ctx.config = { ...ctx.config, blobs: { ...ctx.config.blobs, skip_mime_types: ["video/*"] } };

		const dry = await pruneOperation.handler({ strip_blob_bytes: true, dry_run: true }, ctx);
		expect(dry.stripped_blob_bytes).toBeGreaterThanOrEqual(1);
		expect(dry.reclaimed_bytes).toBeGreaterThanOrEqual(2048);

		// Confirm dry-run didn't actually null anything.
		const stillHasBytes = await ctx.db.queryGet<{ has_bytes: boolean }>(
			`SELECT bytes IS NOT NULL AS has_bytes FROM blobs WHERE sha256 = 'strip-target'`,
		);
		expect(stillHasBytes?.has_bytes).toBe(true);
	});

	test("prune --strip-blob-bytes --no-dry-run nulls bytes on policy-failing rows", async () => {
		const applied = await pruneOperation.handler({ strip_blob_bytes: true, dry_run: false }, ctx);
		expect(applied.stripped_blob_bytes).toBeGreaterThanOrEqual(1);

		const after = await ctx.db.queryGet<{ has_bytes: boolean }>(
			`SELECT bytes IS NOT NULL AS has_bytes FROM blobs WHERE sha256 = 'strip-target'`,
		);
		expect(after?.has_bytes).toBe(false);
	});

	test("prune with neither --before nor --strip-blob-bytes throws HelpfulError", async () => {
		try {
			await pruneOperation.handler({ strip_blob_bytes: false, dry_run: true }, ctx);
			throw new Error("expected throw");
		} catch (err) {
			expect(err).toBeInstanceOf(HelpfulError);
			expect((err as HelpfulError).kind).toBe("input_error");
		}
	});
});
