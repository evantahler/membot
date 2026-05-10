import { describe, expect, test } from "bun:test";
import { defaultLogicalForUrl, normalizeLogicalPath, pickLogicalPath } from "../../src/ingest/ingest.ts";
import type { ResolvedLocalEntry } from "../../src/ingest/source-resolver.ts";

const entry = (absPath: string, relPathFromBase: string): ResolvedLocalEntry => ({
	absPath,
	relPathFromBase,
});

describe("normalizeLogicalPath", () => {
	test("strips a single leading slash", () => {
		expect(normalizeLogicalPath("/Users/evan/projA/README.md")).toBe("Users/evan/projA/README.md");
	});

	test("strips multiple leading slashes", () => {
		expect(normalizeLogicalPath("///etc/hosts")).toBe("etc/hosts");
	});

	test("converts windows backslashes to forward slashes", () => {
		expect(normalizeLogicalPath("C:\\Users\\evan\\projA\\README.md")).toBe("C:/Users/evan/projA/README.md");
	});
});

describe("pickLogicalPath", () => {
	test("default: uses the entry's absolute path with leading slash stripped", () => {
		expect(pickLogicalPath(undefined, entry("/Users/evan/projA/README.md", "README.md"), false)).toBe(
			"Users/evan/projA/README.md",
		);
	});

	test("default avoids basename collisions across project roots", () => {
		const a = pickLogicalPath(undefined, entry("/Users/evan/projA/README.md", "README.md"), false);
		const b = pickLogicalPath(undefined, entry("/Users/evan/projB/README.md", "README.md"), false);
		expect(a).not.toBe(b);
	});

	test("explicit logical_path on a single source: used verbatim (after normalization)", () => {
		expect(pickLogicalPath("notes/auth.md", entry("/tmp/whatever.md", "whatever.md"), false)).toBe("notes/auth.md");
	});

	test("explicit logical_path with a leading slash is normalized so read can find it", () => {
		expect(pickLogicalPath("/notes/auth.md", entry("/tmp/whatever.md", "whatever.md"), false)).toBe("notes/auth.md");
	});

	test("explicit logical_path on a multi-entry walk: treated as a prefix over relPathFromBase", () => {
		expect(pickLogicalPath("docs", entry("/tmp/x/sub/a.md", "sub/a.md"), true)).toBe("docs/sub/a.md");
	});

	test("explicit prefix with trailing slash is normalized", () => {
		expect(pickLogicalPath("docs/", entry("/tmp/x/a.md", "a.md"), true)).toBe("docs/a.md");
	});
});

describe("defaultLogicalForUrl", () => {
	test("preserves path slashes for hierarchy under remotes/{host}/", () => {
		expect(defaultLogicalForUrl("https://github.com/userA/projA/blob/main/README.md")).toBe(
			"remotes/github.com/userA/projA/blob/main/README.md",
		);
	});

	test("two same-basename URLs from different projects do not collide", () => {
		const a = defaultLogicalForUrl("https://github.com/userA/projA/blob/main/README.md");
		const b = defaultLogicalForUrl("https://github.com/userB/projB/blob/main/README.md");
		expect(a).not.toBe(b);
	});

	test("empty path falls back to 'index'", () => {
		expect(defaultLogicalForUrl("https://example.com")).toBe("remotes/example.com/index");
		expect(defaultLogicalForUrl("https://example.com/")).toBe("remotes/example.com/index");
	});

	test("trailing slash on a non-empty path is dropped (so /foo/ and /foo collide on identity, by design)", () => {
		expect(defaultLogicalForUrl("https://example.com/foo/")).toBe("remotes/example.com/foo");
	});

	test("query string and fragment are dropped from logical_path", () => {
		expect(defaultLogicalForUrl("https://example.com/foo/bar?x=1&y=2#section")).toBe("remotes/example.com/foo/bar");
	});

	test("malformed URL falls back to a sanitized identifier", () => {
		expect(defaultLogicalForUrl("not a url")).toMatch(/^remotes\//);
	});
});
