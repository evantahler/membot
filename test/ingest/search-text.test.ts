import { describe, expect, test } from "bun:test";
import { buildSearchText, truncateAtWord } from "../../src/ingest/search-text.ts";

describe("buildSearchText", () => {
	test("prepends path and description to chunk", () => {
		const out = buildSearchText("docs/auth.md", "Notes on the auth flow", "body text");
		expect(out).toBe("docs/auth.md\nNotes on the auth flow\n\nbody text");
	});

	test("handles null description", () => {
		const out = buildSearchText("p.md", null, "x");
		expect(out).toBe("p.md\n\n\nx");
	});

	test("trims whitespace-only descriptions to empty", () => {
		const out = buildSearchText("p.md", "   \n  ", "x");
		expect(out).toBe("p.md\n\n\nx");
	});

	test("with context: breadcrumb line between description and body", () => {
		expect(buildSearchText("docs/a.md", "About A", "body text", "Doc > Section")).toBe(
			"docs/a.md\nAbout A\nDoc > Section\n\nbody text",
		);
	});

	test("empty/null context degrades to the no-context shape", () => {
		expect(buildSearchText("a.md", "desc", "body", "")).toBe("a.md\ndesc\n\nbody");
		expect(buildSearchText("a.md", "desc", "body", null)).toBe("a.md\ndesc\n\nbody");
		expect(buildSearchText("a.md", "desc", "body", "   ")).toBe("a.md\ndesc\n\nbody");
	});

	test("long descriptions are capped so they don't eat the embedding window", () => {
		const longDesc = `${"alpha beta gamma ".repeat(30)}end`; // ~510 chars
		const out = buildSearchText("a.md", longDesc, "body");
		const descLine = out.split("\n")[1] ?? "";
		expect(descLine.length).toBeLessThanOrEqual(241); // 240 + ellipsis
		expect(descLine.endsWith("…")).toBe(true);
	});
});

describe("truncateAtWord", () => {
	test("returns short text unchanged", () => {
		expect(truncateAtWord("hello world", 50)).toBe("hello world");
	});

	test("cuts at a word boundary and appends ellipsis", () => {
		const out = truncateAtWord("the quick brown fox jumps over the lazy dog", 20);
		expect(out.length).toBeLessThanOrEqual(21);
		expect(out.endsWith("…")).toBe(true);
		expect(out).not.toContain("jum"); // no mid-word cut
	});

	test("falls back to a hard cut when there is no usable space", () => {
		const out = truncateAtWord("x".repeat(100), 20);
		expect(out).toBe(`${"x".repeat(20)}…`);
	});
});
