import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isGlob, resolveSource } from "../../src/ingest/source-resolver.ts";

describe("resolveSource", () => {
	let tmp: string;

	beforeAll(() => {
		tmp = mkdtempSync(join(tmpdir(), "membot-src-"));
		mkdirSync(join(tmp, "sub"));
		writeFileSync(join(tmp, "a.md"), "A");
		writeFileSync(join(tmp, "b.txt"), "B");
		writeFileSync(join(tmp, "sub", "c.md"), "C");
		writeFileSync(join(tmp, "sub", "d.json"), "{}");
	});

	afterAll(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	test("inline source", async () => {
		const r = await resolveSource("inline:hello world");
		expect(r.kind).toBe("inline");
		if (r.kind === "inline") expect(r.text).toBe("hello world");
	});

	test("URL source", async () => {
		const r = await resolveSource("https://example.com/x");
		expect(r.kind).toBe("url");
		if (r.kind === "url") expect(r.url).toBe("https://example.com/x");
	});

	test("single file source carries the absolute realpath", async () => {
		const r = await resolveSource(join(tmp, "a.md"));
		expect(r.kind).toBe("local-files");
		if (r.kind === "local-files") {
			expect(r.entries).toHaveLength(1);
			const entry = r.entries[0]!;
			expect(entry.absPath.endsWith("a.md")).toBe(true);
			// absPath is absolute (starts with `/` on posix), so a default
			// logical_path can be derived without losing directory context.
			expect(entry.absPath.startsWith("/") || /^[A-Z]:/.test(entry.absPath)).toBe(true);
			expect(entry.relPathFromBase).toBe("a.md");
		}
	});

	test("directory walk respects include filter", async () => {
		const r = await resolveSource(tmp, { include: "**/*.md" });
		expect(r.kind).toBe("local-files");
		if (r.kind === "local-files") {
			const paths = r.entries.map((e) => e.relPathFromBase).sort();
			expect(paths).toEqual(["a.md", "sub/c.md"]);
		}
	});

	test("directory walk respects exclude filter", async () => {
		const r = await resolveSource(tmp, { include: "**/*", exclude: "**/sub/**" });
		expect(r.kind).toBe("local-files");
		if (r.kind === "local-files") {
			const paths = r.entries.map((e) => e.relPathFromBase).sort();
			expect(paths).toEqual(["a.md", "b.txt"]);
		}
	});

	test("missing path raises HelpfulError", async () => {
		expect(resolveSource(join(tmp, "does-not-exist"))).rejects.toMatchObject({ kind: "not_found" });
	});

	test("isGlob detects wildcards", () => {
		expect(isGlob("docs/*.md")).toBe(true);
		expect(isGlob("docs/file.md")).toBe(false);
		expect(isGlob("**/x")).toBe(true);
	});

	test("glob source filters without ORing default include", async () => {
		const cwd = process.cwd();
		try {
			process.chdir(tmp);
			const r = await resolveSource("*.md");
			expect(r.kind).toBe("local-files");
			if (r.kind === "local-files") {
				const paths = r.entries.map((e) => e.relPathFromBase).sort();
				expect(paths).toEqual(["a.md"]);
			}
		} finally {
			process.chdir(cwd);
		}
	});

	test("glob source with multi-segment pattern matches under base", async () => {
		const r = await resolveSource(join(tmp, "**", "*.md"));
		expect(r.kind).toBe("local-files");
		if (r.kind === "local-files") {
			const paths = r.entries.map((e) => e.relPathFromBase).sort();
			expect(paths).toEqual(["a.md", "sub/c.md"]);
		}
	});

	test("glob source intersects with explicit --include", async () => {
		const r = await resolveSource(join(tmp, "**", "*"), { include: "*.md" });
		expect(r.kind).toBe("local-files");
		if (r.kind === "local-files") {
			const paths = r.entries.map((e) => e.relPathFromBase).sort();
			expect(paths).toEqual(["a.md"]);
		}
	});

	test("directory source without include defaults to all files", async () => {
		const r = await resolveSource(tmp);
		expect(r.kind).toBe("local-files");
		if (r.kind === "local-files") {
			const paths = r.entries.map((e) => e.relPathFromBase).sort();
			expect(paths).toEqual(["a.md", "b.txt", "sub/c.md", "sub/d.json"]);
		}
	});
});
