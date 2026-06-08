import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reembedAllVersions } from "../../src/commands/reindex.ts";
import { MembotConfigSchema } from "../../src/config/schemas.ts";
import { EMBEDDING_REVISION } from "../../src/constants.ts";
import type { AppContext } from "../../src/context.ts";
import { closeContext } from "../../src/context.ts";
import { listChunksForVersion } from "../../src/db/chunks.ts";
import { openDb } from "../../src/db/connection.ts";
import { getCurrent } from "../../src/db/files.ts";
import { getMeta, META_EMBEDDING_REVISION, setMeta, warnIfStaleEmbeddingRevision } from "../../src/db/meta.ts";
import { setEmbeddingCacheDir } from "../../src/ingest/embedder.ts";
import { writeOperation } from "../../src/operations/write.ts";
import { logger } from "../../src/output/logger.ts";
import { createProgress } from "../../src/output/progress.ts";

let tmp: string;
let ctx: AppContext;

describe("reindex --embeddings (reembedAllVersions)", () => {
	beforeEach(async () => {
		tmp = realpathSync(mkdtempSync(join(tmpdir(), "membot-reindex-")));
		setEmbeddingCacheDir(join(tmp, "models"));
		const config = MembotConfigSchema.parse({ data_dir: tmp });
		const db = await openDb(join(tmp, "index.duckdb"));
		ctx = { config, dataDir: tmp, configPath: join(tmp, "config.json"), db, logger, progress: createProgress() };
	});

	afterEach(async () => {
		await closeContext(ctx);
		rmSync(tmp, { recursive: true, force: true });
	});

	test("re-embeds every version and bumps the revision to current", async () => {
		await writeOperation.handler(
			{ logical_path: "docs/auth.md", content: "# Auth\n\nOAuth 2.0 flow with PKCE and refresh tokens." },
			ctx,
		);
		await writeOperation.handler(
			{ logical_path: "docs/db.md", content: "# DB\n\nUse EXPLAIN to inspect query plans." },
			ctx,
		);

		// Simulate an old store: pretend these were embedded under revision 1.
		await setMeta(ctx.db, META_EMBEDDING_REVISION, "1");
		expect(await warnIfStaleEmbeddingRevision(ctx.db)).toBe(true);

		const result = await reembedAllVersions(ctx);
		expect(result.versions).toBe(2);
		expect(result.chunks).toBeGreaterThanOrEqual(2);

		// Revision bumped; warning clears.
		expect(await getMeta(ctx.db, META_EMBEDDING_REVISION)).toBe(String(EMBEDDING_REVISION));
		expect(await warnIfStaleEmbeddingRevision(ctx.db)).toBe(false);

		// Chunks still present and embedded for each version.
		const auth = await getCurrent(ctx.db, "docs/auth.md");
		expect(auth).not.toBeNull();
		const chunks = await listChunksForVersion(ctx.db, "docs/auth.md", auth?.version_id ?? "");
		expect(chunks.length).toBeGreaterThan(0);
		expect(chunks[0]?.embedding.length).toBeGreaterThan(0);
	}, 120_000);

	test("re-embedding is content-preserving and idempotent on chunk count", async () => {
		await writeOperation.handler(
			{ logical_path: "docs/guide.md", content: "# Guide\n\n## A\n\nalpha.\n\n## B\n\nbeta." },
			ctx,
		);
		const before = await getCurrent(ctx.db, "docs/guide.md");
		const beforeChunks = await listChunksForVersion(ctx.db, "docs/guide.md", before?.version_id ?? "");

		await reembedAllVersions(ctx);

		const after = await getCurrent(ctx.db, "docs/guide.md");
		// Same version_id (content untouched) and same chunk count.
		expect(after?.version_id).toBe(before?.version_id);
		expect(after?.content).toBe(before?.content);
		const afterChunks = await listChunksForVersion(ctx.db, "docs/guide.md", after?.version_id ?? "");
		expect(afterChunks).toHaveLength(beforeChunks.length);
	}, 120_000);

	test("empty store still advances the revision", async () => {
		await setMeta(ctx.db, META_EMBEDDING_REVISION, "1");
		const result = await reembedAllVersions(ctx);
		expect(result.versions).toBe(0);
		expect(await getMeta(ctx.db, META_EMBEDDING_REVISION)).toBe(String(EMBEDDING_REVISION));
	});
});
