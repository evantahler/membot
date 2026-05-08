import { describe, expect, test } from "bun:test";
import { detectMode } from "../../src/output/tty.ts";

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
