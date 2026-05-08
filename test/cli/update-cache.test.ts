import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearUpdateCache, loadUpdateCache, saveUpdateCache } from "../../src/update/cache.ts";
import type { UpdateCache } from "../../src/update/checker.ts";

let tmpHome: string;
let origHome: string | undefined;

beforeEach(() => {
	tmpHome = mkdtempSync(join(tmpdir(), "membot-cache-"));
	origHome = process.env.MEMBOT_HOME;
	process.env.MEMBOT_HOME = tmpHome;
});

afterEach(() => {
	if (origHome === undefined) delete process.env.MEMBOT_HOME;
	else process.env.MEMBOT_HOME = origHome;
	rmSync(tmpHome, { recursive: true, force: true });
});

describe("update cache", () => {
	test("loadUpdateCache returns undefined when no file exists", async () => {
		expect(await loadUpdateCache()).toBeUndefined();
	});

	test("saveUpdateCache + loadUpdateCache round-trip", async () => {
		const cache: UpdateCache = {
			lastCheckAt: "2026-01-01T00:00:00.000Z",
			latestVersion: "1.2.3",
			hasUpdate: true,
			changelog: "## v1.2.3\nFix bug",
		};

		await saveUpdateCache(cache);
		const loaded = await loadUpdateCache();

		expect(loaded).toEqual(cache);
	});

	test("clearUpdateCache empties the file", async () => {
		await saveUpdateCache({
			lastCheckAt: "2026-01-01T00:00:00.000Z",
			latestVersion: "1.0.0",
			hasUpdate: false,
		});

		await clearUpdateCache();

		expect(await loadUpdateCache()).toBeUndefined();
	});
});
