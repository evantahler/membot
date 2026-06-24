import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@huggingface/transformers";
import { ensureEmbeddingModelDownloaded, setEmbeddingCacheDir } from "../../src/ingest/embedder.ts";

const ENV_KEY = "MEMBOT_MODEL_CACHE_DIR";

describe("setEmbeddingCacheDir / ensureEmbeddingModelDownloaded", () => {
	let originalCacheDir: string | null | undefined;
	let originalEnv: string | undefined;
	let tmp: string;

	beforeEach(() => {
		// env.cacheDir is a transformers-wide singleton shared across the test
		// process — snapshot and restore it so other test files keep their cache.
		originalCacheDir = env.cacheDir;
		originalEnv = process.env[ENV_KEY];
		delete process.env[ENV_KEY];
		tmp = mkdtempSync(join(tmpdir(), "membot-cache-"));
	});

	afterEach(() => {
		env.cacheDir = originalCacheDir ?? null;
		if (originalEnv === undefined) delete process.env[ENV_KEY];
		else process.env[ENV_KEY] = originalEnv;
		rmSync(tmp, { recursive: true, force: true });
	});

	test("sets env.cacheDir to the given dir with a trailing slash", () => {
		setEmbeddingCacheDir(join(tmp, "models"));
		expect(env.cacheDir).toBe(`${join(tmp, "models")}/`);
	});

	test("MEMBOT_MODEL_CACHE_DIR overrides the provided dir", () => {
		const override = join(tmp, "override");
		process.env[ENV_KEY] = override;
		setEmbeddingCacheDir(join(tmp, "ignored"));
		expect(env.cacheDir).toBe(`${override}/`);
	});

	test("ensureEmbeddingModelDownloaded is a no-op when the model dir already exists (no network)", async () => {
		const cacheDir = join(tmp, "models");
		setEmbeddingCacheDir(cacheDir);
		// Simulate a warm cache: transformers stores each model under <cacheDir>/<model>.
		mkdirSync(join(cacheDir, "Xenova", "fake-model"), { recursive: true });

		// If the gating were broken this would attempt a real HuggingFace fetch
		// of a non-existent model and reject; a fast clean resolve proves the
		// `isModelCached` short-circuit fired.
		await expect(ensureEmbeddingModelDownloaded("Xenova/fake-model", { keepLoaded: false })).resolves.toBeUndefined();
	});
});
