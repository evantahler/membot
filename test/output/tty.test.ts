import { describe, expect, test } from "bun:test";
import { detectMode } from "../../src/output/tty.ts";

/**
 * Save and clear the env vars that detectMode() consults for silent/CI/test
 * detection, so the test starts from a known baseline. Returns a restorer.
 */
function isolateSilenceEnv(): () => void {
	const keys = ["CI", "NODE_ENV", "MEMBOT_SILENT"];
	const prev: Record<string, string | undefined> = {};
	for (const k of keys) {
		prev[k] = process.env[k];
		delete process.env[k];
	}
	return () => {
		for (const k of keys) {
			if (prev[k] === undefined) delete process.env[k];
			else process.env[k] = prev[k];
		}
	};
}

describe("detectMode", () => {
	test("json forces non-interactive and disables color", () => {
		const m = detectMode({ json: true });
		expect(m.interactive).toBe(false);
		expect(m.color).toBe(false);
		expect(m.json).toBe(true);
	});

	test("CI=true forces non-interactive even on TTY", () => {
		const prev = process.env.CI;
		process.env.CI = "true";
		try {
			const m = detectMode({});
			expect(m.interactive).toBe(false);
		} finally {
			if (prev === undefined) delete process.env.CI;
			else process.env.CI = prev;
		}
	});

	test("noColor flag disables color even in TTY mode", () => {
		const m = detectMode({ noColor: true });
		expect(m.color).toBe(false);
	});

	test("forceColor wins over noColor", () => {
		const m = detectMode({ noColor: true, forceColor: true });
		expect(m.color).toBe(true);
	});

	test("verbose carries through", () => {
		const m = detectMode({ verbose: true });
		expect(m.verbose).toBe(true);
	});
});

describe("detectMode silent", () => {
	test("NODE_ENV=test → silent", () => {
		const restore = isolateSilenceEnv();
		process.env.NODE_ENV = "test";
		try {
			expect(detectMode({}).silent).toBe(true);
		} finally {
			restore();
		}
	});

	test("CI=true → silent", () => {
		const restore = isolateSilenceEnv();
		process.env.CI = "true";
		try {
			const m = detectMode({});
			expect(m.silent).toBe(true);
			expect(m.interactive).toBe(false);
		} finally {
			restore();
		}
	});

	test("MEMBOT_SILENT=1 → silent", () => {
		const restore = isolateSilenceEnv();
		process.env.MEMBOT_SILENT = "1";
		try {
			expect(detectMode({}).silent).toBe(true);
		} finally {
			restore();
		}
	});

	test("verbose overrides silent", () => {
		const restore = isolateSilenceEnv();
		process.env.CI = "true";
		process.env.NODE_ENV = "test";
		try {
			expect(detectMode({ verbose: true }).silent).toBe(false);
		} finally {
			restore();
		}
	});

	test("json does not set silent (json suppresses info on its own)", () => {
		const restore = isolateSilenceEnv();
		try {
			expect(detectMode({ json: true }).silent).toBe(false);
		} finally {
			restore();
		}
	});

	test("no env signals → not silent", () => {
		const restore = isolateSilenceEnv();
		try {
			expect(detectMode({}).silent).toBe(false);
		} finally {
			restore();
		}
	});
});
