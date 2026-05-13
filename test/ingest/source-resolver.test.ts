import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { expandUserPattern, isGlob, resolveSource } from "../../src/ingest/source-resolver.ts";
import "../../src/ingest/sources/index.ts";

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

	test("URL source claimed by a registered plugin resolves into a single entry", async () => {
		const r = await resolveSource("https://github.com/evantahler/membot/issues/1");
		expect(r.kind).toBe("plugin");
		if (r.kind === "plugin") {
			expect(r.plugin.name).toBe("github");
			expect(r.entries).toHaveLength(1);
		}
	});

	test("URL with no matching plugin throws a clear input_error", async () => {
		expect(resolveSource("https://example.com/x")).rejects.toMatchObject({ kind: "input_error" });
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

	test("single-file source honors DEFAULT_EXCLUDES (e.g. node_modules)", async () => {
		// Simulates zsh having pre-expanded `~/proj/**/*.md` into a list of
		// individual file paths — including ones inside node_modules.
		mkdirSync(join(tmp, "node_modules"));
		mkdirSync(join(tmp, "node_modules", "lib"));
		writeFileSync(join(tmp, "node_modules", "lib", "index.md"), "no");
		try {
			const r = await resolveSource(join(tmp, "node_modules", "lib", "index.md"));
			expect(r.kind).toBe("local-files");
			if (r.kind === "local-files") {
				expect(r.entries).toEqual([]);
				expect(r.filtered).toBe(true);
			}
		} finally {
			rmSync(join(tmp, "node_modules"), { recursive: true, force: true });
		}
	});

	test("single-file source honors user --exclude (gitignore-ish)", async () => {
		const r = await resolveSource(join(tmp, "sub", "c.md"), { exclude: "sub/*" });
		expect(r.kind).toBe("local-files");
		if (r.kind === "local-files") {
			expect(r.entries).toEqual([]);
			expect(r.filtered).toBe(true);
		}
	});

	test("single-file source honors --include narrowing", async () => {
		const r = await resolveSource(join(tmp, "b.txt"), { include: "*.md" });
		expect(r.kind).toBe("local-files");
		if (r.kind === "local-files") {
			expect(r.entries).toEqual([]);
			expect(r.filtered).toBe(true);
		}
	});

	test("directory walk: bare-name --exclude drops the whole subtree", async () => {
		const r = await resolveSource(tmp, { include: "**/*", exclude: "sub" });
		expect(r.kind).toBe("local-files");
		if (r.kind === "local-files") {
			const paths = r.entries.map((e) => e.relPathFromBase).sort();
			expect(paths).toEqual(["a.md", "b.txt"]);
		}
	});

	test("directory walk prunes excluded subtrees instead of descending", async () => {
		// Build a deep nested directory under sub/ that, if walked into, would
		// add many entries. With dir-pruning, we never readdir() into it.
		const deep = join(tmp, "sub", "deep");
		mkdirSync(join(deep, "a", "b", "c"), { recursive: true });
		writeFileSync(join(deep, "a", "b", "c", "buried.md"), "X");
		try {
			const r = await resolveSource(tmp, { include: "**/*", exclude: "sub/*" });
			expect(r.kind).toBe("local-files");
			if (r.kind === "local-files") {
				const paths = r.entries.map((e) => e.relPathFromBase).sort();
				expect(paths).toEqual(["a.md", "b.txt"]);
				// `sub/deep/a/b/c/buried.md` would only be reachable if the walker
				// descended into `sub/`. Pruning means it's never even stat'd.
			}
		} finally {
			rmSync(deep, { recursive: true, force: true });
		}
	});

	test("directory walk: trailing /* --exclude drops the whole subtree", async () => {
		const r = await resolveSource(tmp, { include: "**/*", exclude: "sub/*" });
		expect(r.kind).toBe("local-files");
		if (r.kind === "local-files") {
			const paths = r.entries.map((e) => e.relPathFromBase).sort();
			expect(paths).toEqual(["a.md", "b.txt"]);
		}
	});

	test("leading ~ in source is expanded to homedir", async () => {
		// Make a tmp dir explicitly under $HOME so the test exercises the
		// tilde-expansion path even on systems where tmpdir() lives outside
		// homedir (e.g. macOS /var/folders).
		const homeTmp = mkdtempSync(join(homedir(), ".membot-tilde-test-"));
		try {
			writeFileSync(join(homeTmp, "x.md"), "X");
			const rel = relative(homedir(), homeTmp);
			const r = await resolveSource(`~/${rel}/x.md`);
			expect(r.kind).toBe("local-files");
			if (r.kind === "local-files") {
				expect(r.entries).toHaveLength(1);
				expect(r.entries[0]!.absPath.endsWith("x.md")).toBe(true);
			}
		} finally {
			rmSync(homeTmp, { recursive: true, force: true });
		}
	});

	test("leading ~ in glob source is expanded too", async () => {
		const homeTmp = mkdtempSync(join(homedir(), ".membot-tilde-glob-"));
		try {
			writeFileSync(join(homeTmp, "y.md"), "Y");
			const rel = relative(homedir(), homeTmp);
			const r = await resolveSource(`~/${rel}/*.md`);
			expect(r.kind).toBe("local-files");
			if (r.kind === "local-files") {
				const paths = r.entries.map((e) => e.relPathFromBase);
				expect(paths).toEqual(["y.md"]);
			}
		} finally {
			rmSync(homeTmp, { recursive: true, force: true });
		}
	});

	test("expandUserPattern emits intuitive variants", () => {
		// Bare directory name → matches at any depth, recursively.
		expect(expandUserPattern("node_modules")).toEqual(
			expect.arrayContaining(["node_modules", "**/node_modules", "**/node_modules/**"]),
		);
		// `dir/*` → also recursive.
		expect(expandUserPattern("node_modules/*")).toEqual(
			expect.arrayContaining(["node_modules/*", "**/node_modules/*", "node_modules/**", "**/node_modules/**"]),
		);
		// Trailing slash → recursive.
		expect(expandUserPattern("node_modules/")).toEqual(
			expect.arrayContaining(["node_modules/", "node_modules/**", "**/node_modules/**"]),
		);
		// Already canonical → pass-through (no `**/<p>` since it's anchored).
		const canonical = expandUserPattern("**/node_modules/**");
		expect(canonical).toContain("**/node_modules/**");
		expect(canonical).not.toContain("**/**/node_modules/**");
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
