import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resolveEmbeddingWorkers } from "../src/context.ts";
import { DEFAULTS } from "../src/constants.ts";

describe("resolveEmbeddingWorkers", () => {
	const ENV_KEY = "MEMBOT_EMBEDDING_WORKERS";
	let originalEnv: string | undefined;

	beforeEach(() => {
		originalEnv = process.env[ENV_KEY];
		delete process.env[ENV_KEY];
	});

	afterEach(() => {
		if (originalEnv === undefined) delete process.env[ENV_KEY];
		else process.env[ENV_KEY] = originalEnv;
	});

	test("clamps explicit config above MAX_WORKERS down to the cap", () => {
		expect(resolveEmbeddingWorkers(99)).toBe(DEFAULTS.MAX_WORKERS);
		expect(resolveEmbeddingWorkers(DEFAULTS.MAX_WORKERS + 1)).toBe(DEFAULTS.MAX_WORKERS);
	});

	test("returns explicit config below the cap unchanged", () => {
		expect(resolveEmbeddingWorkers(1)).toBe(1);
		expect(resolveEmbeddingWorkers(DEFAULTS.MAX_WORKERS)).toBe(DEFAULTS.MAX_WORKERS);
	});

	test("clamps env override above MAX_WORKERS", () => {
		process.env[ENV_KEY] = "20";
		expect(resolveEmbeddingWorkers(null)).toBe(DEFAULTS.MAX_WORKERS);
	});

	test("respects env override below the cap", () => {
		process.env[ENV_KEY] = "2";
		expect(resolveEmbeddingWorkers(null)).toBe(2);
	});

	test("default (no config, no env) is at most MAX_WORKERS even on a high-core box", () => {
		// We can't fake cpus().length cheaply in this harness, but the only
		// way the default branch returns more than MAX_WORKERS is if the
		// clamp is missing — which is the bug this test guards.
		const got = resolveEmbeddingWorkers(null);
		expect(got).toBeGreaterThanOrEqual(1);
		expect(got).toBeLessThanOrEqual(DEFAULTS.MAX_WORKERS);
	});

	test("floors fractional inputs", () => {
		process.env[ENV_KEY] = "3.9";
		expect(resolveEmbeddingWorkers(null)).toBe(3);
	});
});
