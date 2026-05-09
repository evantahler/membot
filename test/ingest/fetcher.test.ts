import { describe, expect, test } from "bun:test";
import { findDownloader, findDownloaderByName, listDownloaders } from "../../src/ingest/downloaders/index.ts";

describe("downloader registry", () => {
	test("listDownloaders surfaces every registered handler with non-empty descriptions", () => {
		const all = listDownloaders();
		expect(all.length).toBeGreaterThanOrEqual(6);
		for (const d of all) {
			expect(d.name.length).toBeGreaterThan(0);
			expect(d.description.length).toBeGreaterThan(20);
		}
		const names = all.map((d) => d.name);
		for (const expected of ["google-docs", "google-sheets", "google-slides", "github", "linear", "generic-web"]) {
			expect(names).toContain(expected);
		}
	});

	test("findDownloaderByName is case-sensitive and returns null for unknowns", () => {
		expect(findDownloaderByName("google-docs")?.name).toBe("google-docs");
		expect(findDownloaderByName("GOOGLE-DOCS")).toBeNull();
		expect(findDownloaderByName("nonexistent")).toBeNull();
	});

	test("findDownloader returns null for non-URL input", () => {
		expect(findDownloader("not a url")).toBeNull();
		expect(findDownloader("")).toBeNull();
	});

	test("findDownloader: Google Docs URL → google-docs", () => {
		const d = findDownloader("https://docs.google.com/document/d/abc123/edit");
		expect(d?.name).toBe("google-docs");
	});

	test("findDownloader: Google Sheets URL → google-sheets", () => {
		const d = findDownloader("https://docs.google.com/spreadsheets/d/abc123/edit#gid=0");
		expect(d?.name).toBe("google-sheets");
	});

	test("findDownloader: Google Slides URL → google-slides", () => {
		const d = findDownloader("https://docs.google.com/presentation/d/abc123/edit");
		expect(d?.name).toBe("google-slides");
	});

	test("findDownloader: GitHub issue URL → github", () => {
		const d = findDownloader("https://github.com/owner/repo/issues/42");
		expect(d?.name).toBe("github");
	});

	test("findDownloader: GitHub PR URL → github", () => {
		const d = findDownloader("https://github.com/owner/repo/pull/100");
		expect(d?.name).toBe("github");
	});

	test("findDownloader: GitHub repo root → generic-web (no specific handler)", () => {
		const d = findDownloader("https://github.com/owner/repo");
		expect(d?.name).toBe("generic-web");
	});

	test("findDownloader: Linear issue URL → linear", () => {
		const d = findDownloader("https://linear.app/arcade/issue/ABC-123");
		expect(d?.name).toBe("linear");
	});

	test("findDownloader: Linear project URL → linear", () => {
		const d = findDownloader("https://linear.app/arcade/project/my-project-abc123");
		expect(d?.name).toBe("linear");
	});

	test("findDownloader: arbitrary URL → generic-web catch-all", () => {
		const d = findDownloader("https://example.com/some/page");
		expect(d?.name).toBe("generic-web");
	});

	test("generic-web matches http and https only", () => {
		const generic = findDownloaderByName("generic-web");
		expect(generic?.matches(new URL("http://example.com"))).toBe(true);
		expect(generic?.matches(new URL("https://example.com"))).toBe(true);
		expect(generic?.matches(new URL("file:///etc/hosts"))).toBe(false);
	});

	test("specific downloaders do not match unrelated URLs", () => {
		const docs = findDownloaderByName("google-docs");
		expect(docs?.matches(new URL("https://docs.google.com/spreadsheets/d/abc/edit"))).toBe(false);
		expect(docs?.matches(new URL("https://example.com/document/d/abc/edit"))).toBe(false);
		const linear = findDownloaderByName("linear");
		expect(linear?.matches(new URL("https://linear.app/arcade/team/abc"))).toBe(false);
	});
});
