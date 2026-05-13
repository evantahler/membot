import { describe, expect, test } from "bun:test";
import "../../src/ingest/sources/index.ts";
import { findSourceByName, findSourceForInput, listSources } from "../../src/ingest/sources/registry.ts";

describe("source plugin registry", () => {
	test("listSources surfaces every registered plugin with non-empty descriptions and examples", () => {
		const all = listSources();
		expect(all.length).toBeGreaterThanOrEqual(8);
		for (const p of all) {
			expect(p.name.length).toBeGreaterThan(0);
			expect(p.description.length).toBeGreaterThan(20);
			expect(Array.isArray(p.examples)).toBe(true);
			expect(p.examples.length).toBeGreaterThan(0);
		}
		const names = all.map((p) => p.name);
		for (const expected of [
			"google-docs",
			"google-sheets",
			"google-slides",
			"github",
			"github-repo",
			"linear",
			"linear-team",
			"generic-web",
		]) {
			expect(names).toContain(expected);
		}
	});

	test("findSourceByName is case-sensitive and returns null for unknowns", () => {
		expect(findSourceByName("google-docs")?.name).toBe("google-docs");
		expect(findSourceByName("GOOGLE-DOCS")).toBeNull();
		expect(findSourceByName("nonexistent")).toBeNull();
	});

	test("findSourceForInput returns null for non-URL input that doesn't match a scheme", () => {
		expect(findSourceForInput("not a url")).toBeNull();
		expect(findSourceForInput("")).toBeNull();
	});

	test("findSourceForInput: Google Docs URL → google-docs", () => {
		const p = findSourceForInput("https://docs.google.com/document/d/abc123/edit");
		expect(p?.name).toBe("google-docs");
	});

	test("findSourceForInput: Google Sheets URL → google-sheets", () => {
		const p = findSourceForInput("https://docs.google.com/spreadsheets/d/abc123/edit#gid=0");
		expect(p?.name).toBe("google-sheets");
	});

	test("findSourceForInput: Google Slides URL → google-slides", () => {
		const p = findSourceForInput("https://docs.google.com/presentation/d/abc123/edit");
		expect(p?.name).toBe("google-slides");
	});

	test("findSourceForInput: GitHub issue URL → github", () => {
		const p = findSourceForInput("https://github.com/owner/repo/issues/42");
		expect(p?.name).toBe("github");
	});

	test("findSourceForInput: GitHub PR URL → github", () => {
		const p = findSourceForInput("https://github.com/owner/repo/pull/100");
		expect(p?.name).toBe("github");
	});

	test("findSourceForInput: GitHub repo root → generic-web (no specific handler)", () => {
		const p = findSourceForInput("https://github.com/owner/repo");
		expect(p?.name).toBe("generic-web");
	});

	test("findSourceForInput: Linear issue URL → linear", () => {
		const p = findSourceForInput("https://linear.app/arcade/issue/ABC-123");
		expect(p?.name).toBe("linear");
	});

	test("findSourceForInput: Linear project URL → linear", () => {
		const p = findSourceForInput("https://linear.app/arcade/project/my-project-abc123");
		expect(p?.name).toBe("linear");
	});

	test("findSourceForInput: arbitrary URL → generic-web catch-all", () => {
		const p = findSourceForInput("https://example.com/some/page");
		expect(p?.name).toBe("generic-web");
	});

	test("findSourceForInput: scheme prefix (linear-team:) → linear-team", () => {
		const p = findSourceForInput("linear-team:ENG");
		expect(p?.name).toBe("linear-team");
	});

	test("findSourceForInput: scheme prefix (github-repo:) → github-repo", () => {
		const p = findSourceForInput("github-repo:facebook/react");
		expect(p?.name).toBe("github-repo");
	});

	test("findSourceForInput: scheme prefix (apple-notes:) wins on darwin", () => {
		const p = findSourceForInput("apple-notes:Personal/Recipes");
		// Only matched on darwin (platform-gated registration); skip on other platforms.
		if (process.platform === "darwin") {
			expect(p?.name).toBe("apple-notes");
		} else {
			expect(p).toBeNull();
		}
	});

	test("generic-web matches http and https only", () => {
		const generic = findSourceByName("generic-web");
		expect(generic?.match.kind).toBe("url");
		if (generic?.match.kind === "url") {
			expect(generic.match.matches(new URL("http://example.com"))).toBe(true);
			expect(generic.match.matches(new URL("https://example.com"))).toBe(true);
			expect(generic.match.matches(new URL("file:///etc/hosts"))).toBe(false);
		}
	});

	test("specific plugins do not match unrelated URLs", () => {
		const docs = findSourceByName("google-docs");
		if (docs?.match.kind === "url") {
			expect(docs.match.matches(new URL("https://docs.google.com/spreadsheets/d/abc/edit"))).toBe(false);
			expect(docs.match.matches(new URL("https://example.com/document/d/abc/edit"))).toBe(false);
		}
		const linear = findSourceByName("linear");
		if (linear?.match.kind === "url") {
			expect(linear.match.matches(new URL("https://linear.app/arcade/team/abc"))).toBe(false);
		}
	});
});
