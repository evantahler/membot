import { describe, expect, test } from "bun:test";
import { detectInstallMethod, isNewerVersion, needsCheck, type UpdateCache } from "../../src/update/checker.ts";

describe("isNewerVersion", () => {
	test("returns true when latest is greater than current", () => {
		expect(isNewerVersion("1.0.0", "1.0.1")).toBe(true);
		expect(isNewerVersion("1.0.0", "2.0.0")).toBe(true);
		expect(isNewerVersion("0.0.1", "0.1.0")).toBe(true);
	});

	test("returns false when latest equals current", () => {
		expect(isNewerVersion("1.2.3", "1.2.3")).toBe(false);
	});

	test("returns false when latest is older than current", () => {
		expect(isNewerVersion("2.0.0", "1.9.9")).toBe(false);
	});
});

describe("needsCheck", () => {
	test("returns true when cache is undefined", () => {
		expect(needsCheck(undefined)).toBe(true);
	});

	test("returns true when cache has no lastCheckAt", () => {
		expect(needsCheck({ lastCheckAt: "", latestVersion: "1.0.0", hasUpdate: false } as UpdateCache)).toBe(true);
	});

	test("returns false when cache is fresh", () => {
		const cache: UpdateCache = {
			lastCheckAt: new Date().toISOString(),
			latestVersion: "1.0.0",
			hasUpdate: false,
		};
		expect(needsCheck(cache)).toBe(false);
	});

	test("returns true when cache is older than 24h", () => {
		const cache: UpdateCache = {
			lastCheckAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
			latestVersion: "1.0.0",
			hasUpdate: false,
		};
		expect(needsCheck(cache)).toBe(true);
	});
});

describe("detectInstallMethod", () => {
	const origArgv1 = process.argv[1];
	const origExecPath = process.execPath;

	function withProcess(argv1: string, execPath: string, fn: () => void): void {
		process.argv[1] = argv1;
		Object.defineProperty(process, "execPath", { value: execPath, configurable: true });
		try {
			fn();
		} finally {
			process.argv[1] = origArgv1 ?? "";
			Object.defineProperty(process, "execPath", { value: origExecPath, configurable: true });
		}
	}

	test("returns 'local-dev' for src/cli.ts outside node_modules", () => {
		withProcess("/home/dev/membot/src/cli.ts", "/home/dev/.bun/bin/bun", () => {
			expect(detectInstallMethod()).toBe("local-dev");
		});
	});

	test("returns 'binary' when execPath is the compiled binary", () => {
		withProcess("/usr/local/bin/membot", "/usr/local/bin/membot", () => {
			expect(detectInstallMethod()).toBe("binary");
		});
	});

	test("returns 'bun' when installed via bun global", () => {
		withProcess("/home/dev/.bun/install/global/node_modules/membot/src/cli.ts", "/home/dev/.bun/bin/bun", () => {
			expect(detectInstallMethod()).toBe("bun");
		});
	});

	test("returns 'npm' when installed via npm global", () => {
		withProcess("/usr/local/lib/node_modules/membot/src/cli.ts", "/usr/local/bin/node", () => {
			expect(detectInstallMethod()).toBe("npm");
		});
	});
});
