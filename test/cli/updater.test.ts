import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FetchLike } from "upgradr";
import pkg from "../../package.json" with { type: "json" };
import { getUpdater } from "../../src/update/updater.ts";

let tmpHome: string;
let origHome: string | undefined;

beforeEach(() => {
	tmpHome = mkdtempSync(join(tmpdir(), "membot-updater-"));
	origHome = process.env.MEMBOT_HOME;
	process.env.MEMBOT_HOME = tmpHome;
});

afterEach(() => {
	if (origHome === undefined) delete process.env.MEMBOT_HOME;
	else process.env.MEMBOT_HOME = origHome;
	rmSync(tmpHome, { recursive: true, force: true });
});

/** A `fetch` stub that returns `version` for the npm-registry lookup and an empty release list for GitHub. */
function stubFetch(version: string): FetchLike {
	return async (input) => {
		const url = String(input);
		if (url.startsWith("https://registry.npmjs.org/")) {
			return new Response(JSON.stringify({ version }), { status: 200 });
		}
		// GitHub releases changelog lookup.
		return new Response("[]", { status: 200 });
	};
}

describe("getUpdater", () => {
	test("exposes the updater surface and correct membot config", () => {
		const updater = getUpdater();
		expect(typeof updater.checkForUpdate).toBe("function");
		expect(typeof updater.upgrade).toBe("function");
		expect(typeof updater.maybeBackgroundNotice).toBe("function");

		expect(updater.config.repo).toBe("evantahler/membot");
		expect(updater.config.binaryName).toBe("membot");
		expect(updater.config.cliName).toBe("membot");
		expect(updater.config.packageName).toBe(pkg.name);
		expect(updater.config.currentVersion).toBe(pkg.version);
	});

	test("cacheDir tracks MEMBOT_HOME at call time", () => {
		expect(getUpdater().config.cacheDir).toBe(tmpHome);

		const other = mkdtempSync(join(tmpdir(), "membot-updater-other-"));
		process.env.MEMBOT_HOME = other;
		try {
			expect(getUpdater().config.cacheDir).toBe(other);
		} finally {
			rmSync(other, { recursive: true, force: true });
		}
	});

	test("checkForUpdate reports an available update (happy path)", async () => {
		const newer = "999.0.0";
		const info = await getUpdater({ fetchImpl: stubFetch(newer) }).checkForUpdate();
		expect(info.hasUpdate).toBe(true);
		expect(info.currentVersion).toBe(pkg.version);
		expect(info.latestVersion).toBe(newer);
	});

	test("checkForUpdate reports no update when latest equals current", async () => {
		const info = await getUpdater({ fetchImpl: stubFetch(pkg.version) }).checkForUpdate();
		expect(info.hasUpdate).toBe(false);
		expect(info.latestVersion).toBe(pkg.version);
	});

	test("checkForUpdate degrades gracefully on network error (no throw)", async () => {
		const failing: FetchLike = async () => {
			throw new Error("network down");
		};
		const info = await getUpdater({ fetchImpl: failing }).checkForUpdate();
		// On failure, upgradr falls back to currentVersion → no update, no throw.
		expect(info.hasUpdate).toBe(false);
		expect(info.latestVersion).toBe(pkg.version);
	});

	test("maybeBackgroundNotice returns a notice for a newer version in a TTY", async () => {
		const notice = await getUpdater({ fetchImpl: stubFetch("999.0.0") }).maybeBackgroundNotice({
			env: {},
			argv: ["bun", "membot", "stats"],
			isTTY: true,
		});
		expect(notice).toContain("Update available");
		expect(notice).toContain("Run `membot upgrade` to update");
	});

	test("maybeBackgroundNotice is suppressed by the opt-out env var", async () => {
		const notice = await getUpdater({ fetchImpl: stubFetch("999.0.0") }).maybeBackgroundNotice({
			env: { MEMBOT_NO_UPDATE_CHECK: "1" },
			argv: ["bun", "membot", "stats"],
			isTTY: true,
		});
		expect(notice).toBeNull();
	});

	test("maybeBackgroundNotice is suppressed outside a TTY", async () => {
		const notice = await getUpdater({ fetchImpl: stubFetch("999.0.0") }).maybeBackgroundNotice({
			env: {},
			argv: ["bun", "membot", "stats"],
			isTTY: false,
		});
		expect(notice).toBeNull();
	});
});
