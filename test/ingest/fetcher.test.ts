import { describe, expect, test } from "bun:test";
import "../../src/ingest/sources/index.ts";
import { findSourceByName, findSourceForInput, listSources } from "../../src/ingest/sources/registry.ts";

describe("source plugin registry", () => {
	test("listSources surfaces every registered plugin with non-empty descriptions and examples", () => {
		const all = listSources();
		expect(all.length).toBeGreaterThanOrEqual(4);
		for (const p of all) {
			expect(p.name.length).toBeGreaterThan(0);
			expect(p.description.length).toBeGreaterThan(20);
			expect(Array.isArray(p.examples)).toBe(true);
			expect(p.examples.length).toBeGreaterThan(0);
		}
		const names = all.map((p) => p.name);
		for (const expected of ["github", "github-repo", "linear", "linear-team"]) {
			expect(names).toContain(expected);
		}
	});

	test("findSourceByName is case-sensitive and returns null for unknowns", () => {
		expect(findSourceByName("github")?.name).toBe("github");
		expect(findSourceByName("GITHUB")).toBeNull();
		expect(findSourceByName("nonexistent")).toBeNull();
	});

	test("findSourceForInput returns null for non-URL input that doesn't match a scheme", () => {
		expect(findSourceForInput("not a url")).toBeNull();
		expect(findSourceForInput("")).toBeNull();
	});

	test("findSourceForInput: Google Docs URL → null (we don't ingest Google natively)", () => {
		expect(findSourceForInput("https://docs.google.com/document/d/abc123/edit")).toBeNull();
	});

	test("findSourceForInput: GitHub issue URL → github", () => {
		const p = findSourceForInput("https://github.com/owner/repo/issues/42");
		expect(p?.name).toBe("github");
	});

	test("findSourceForInput: GitHub PR URL → github", () => {
		const p = findSourceForInput("https://github.com/owner/repo/pull/100");
		expect(p?.name).toBe("github");
	});

	test("findSourceForInput: GitHub repo root → null (no catch-all anymore)", () => {
		expect(findSourceForInput("https://github.com/owner/repo")).toBeNull();
	});

	test("findSourceForInput: Linear issue URL → linear", () => {
		const p = findSourceForInput("https://linear.app/arcade/issue/ABC-123");
		expect(p?.name).toBe("linear");
	});

	test("findSourceForInput: Linear project URL → linear", () => {
		const p = findSourceForInput("https://linear.app/arcade/project/my-project-abc123");
		expect(p?.name).toBe("linear");
	});

	test("findSourceForInput: arbitrary URL → null (we no longer ship generic-web)", () => {
		expect(findSourceForInput("https://example.com/some/page")).toBeNull();
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
		if (process.platform === "darwin") {
			expect(p?.name).toBe("apple-notes");
		} else {
			expect(p).toBeNull();
		}
	});

	test("specific plugins do not match unrelated URLs", () => {
		const linear = findSourceByName("linear");
		if (linear?.match.kind === "url") {
			expect(linear.match.matches(new URL("https://linear.app/arcade/team/abc"))).toBe(false);
		}
	});
});
