import { afterEach, describe, expect, test } from "bun:test";
import ansis from "ansis";
import { colors, formatBytes, renderResult, renderTable } from "../../src/output/formatter.ts";
import { detectMode, setMode } from "../../src/output/tty.ts";

const STRIP = (s: string): string => ansis.strip(s);

afterEach(() => {
	setMode(detectMode({}));
});

describe("renderTable", () => {
	test("renders headers, separator, and rows aligned to column widths", () => {
		const out = renderTable(
			["NAME", "SIZE"],
			[
				["alpha", "12"],
				["the-long-name", "1024"],
			],
		);
		const lines = STRIP(out).split("\n");
		expect(lines).toHaveLength(4);
		expect(lines[0]).toMatch(/^NAME\s+SIZE\s*$/);
		expect(lines[1]).toContain("─");
		expect(lines[2]).toContain("alpha");
		expect(lines[3]).toContain("the-long-name");
		// All body lines should have the same printable width (including padding).
		expect(lines[2]?.length).toBe(lines[3]?.length);
	});

	test("columnStyles invoke their fn on each cell", () => {
		const calls: string[] = [];
		const tracker = (label: string) => (s: string) => {
			calls.push(`${label}:${s.trim()}`);
			return s;
		};
		renderTable(["A", "B"], [["x", "y"]], {
			columnStyles: [tracker("col0"), tracker("col1")],
		});
		expect(calls).toEqual(["col0:x", "col1:y"]);
	});

	test("undefined entries in columnStyles are skipped", () => {
		const calls: string[] = [];
		renderTable(["A", "B"], [["x", "y"]], {
			columnStyles: [
				undefined,
				(s) => {
					calls.push(s.trim());
					return s;
				},
			],
		});
		expect(calls).toEqual(["y"]);
	});

	test("columnStyles do not perturb visible width", () => {
		const out = renderTable(["A"], [["short"], ["very-long-cell"]], {
			columnStyles: [colors.cyan],
		});
		const widths = STRIP(out)
			.split("\n")
			.map((l) => l.length);
		// header, separator, two body rows — all visible widths equal.
		expect(new Set(widths).size).toBe(1);
	});
});

describe("renderResult", () => {
	test("delegates to human renderer in human mode", () => {
		setMode(detectMode({}));
		const out = renderResult({ count: 3 }, { console_formatter: (r) => `${r.count} items` });
		expect(out).toBe("3 items");
	});

	test("returns JSON when --json is set, ignoring human renderer", () => {
		setMode(detectMode({ json: true }));
		const out = renderResult({ count: 3 }, { console_formatter: () => "should not appear" });
		expect(out).toBe(JSON.stringify({ count: 3 }, null, 2));
	});

	test("falls back to pretty JSON when no human renderer is provided", () => {
		setMode(detectMode({}));
		const out = renderResult({ a: 1 });
		expect(out).toBe(JSON.stringify({ a: 1 }, null, 2));
	});

	test("returns string result as-is", () => {
		setMode(detectMode({}));
		expect(renderResult("hello")).toBe("hello");
	});
});

describe("colors helper gates on useColor()", () => {
	test("returns plain text when color is disabled", () => {
		setMode(detectMode({ noColor: true }));
		expect(colors.red("x")).toBe("x");
		expect(colors.cyan("x")).toBe("x");
		expect(colors.green("x")).toBe("x");
		expect(colors.yellow("x")).toBe("x");
		expect(colors.dim("x")).toBe("x");
		expect(colors.bold("x")).toBe("x");
	});

	test("delegates to ansis when color is enabled (plain in test env, but identity holds)", () => {
		// In the test preload, NO_COLOR=1 means ansis itself returns plain text
		// regardless of useColor(). The contract being tested here is just that
		// the gating function doesn't error and returns a string of the same
		// visible content. Real ANSI emission is verified end-to-end on the CLI.
		setMode(detectMode({ forceColor: true }));
		expect(ansis.strip(colors.red("hello"))).toBe("hello");
		expect(ansis.strip(colors.bold("x"))).toBe("x");
	});
});

describe("formatBytes", () => {
	test("renders bytes under 1 KiB as raw bytes", () => {
		expect(formatBytes(0)).toBe("0 B");
		expect(formatBytes(512)).toBe("512 B");
		expect(formatBytes(1023)).toBe("1023 B");
	});

	test("scales up through KB / MB / GB / TB at binary boundaries", () => {
		expect(formatBytes(1024)).toBe("1.0 KB");
		expect(formatBytes(5654)).toBe("5.5 KB"); // typical small markdown
		expect(formatBytes(2 * 1024 * 1024)).toBe("2.0 MB");
		expect(formatBytes(3.5 * 1024 * 1024 * 1024)).toBe("3.5 GB");
		expect(formatBytes(2 * 1024 * 1024 * 1024 * 1024)).toBe("2.0 TB");
	});

	test("drops the decimal once the magnitude reaches 100 in a unit", () => {
		expect(formatBytes(100 * 1024)).toBe("100 KB");
		expect(formatBytes(150 * 1024 * 1024)).toBe("150 MB");
	});

	test("returns 0 B for negative or non-finite input", () => {
		expect(formatBytes(-1)).toBe("0 B");
		expect(formatBytes(Number.NaN)).toBe("0 B");
		expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("0 B");
	});
});
