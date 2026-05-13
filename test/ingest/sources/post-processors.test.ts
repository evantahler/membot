import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyPostProcessor,
	normalizeDocmd,
	substituteVars,
} from "../../../src/ingest/sources/post-processors.ts";

describe("normalizeDocmd", () => {
	test("collapses CRLF to LF", () => {
		expect(normalizeDocmd("a\r\nb\r\nc")).toBe("a\nb\nc");
	});

	test("replaces non-breaking spaces with normal spaces", () => {
		expect(normalizeDocmd("a b")).toBe("a b");
	});

	test("normalizes smart quotes and dashes", () => {
		expect(normalizeDocmd("“abc” ‘x’ — y")).toBe('"abc" \'x\' - y');
	});

	test("collapses 3+ blank lines to 2", () => {
		expect(normalizeDocmd("a\n\n\n\n\nb")).toBe("a\n\nb");
	});

	test("trims trailing whitespace per line", () => {
		expect(normalizeDocmd("a   \nb\t")).toBe("a\nb");
	});
});

describe("substituteVars", () => {
	test("substitutes a named var", () => {
		expect(substituteVars("hello {id}", { id: "42" }, "https://x")).toBe("hello 42");
	});

	test("substitutes {url}", () => {
		expect(substituteVars("{url}", {}, "https://x")).toBe("https://x");
	});

	test("throws when a var is missing", () => {
		expect(() => substituteVars("{missing}", {}, "")).toThrow(/has no value/);
	});
});

describe("applyPostProcessor", () => {
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();

	test("passthrough returns bytes unchanged", async () => {
		const input = encoder.encode("hello");
		const out = await applyPostProcessor("passthrough", input, {}, "");
		expect(decoder.decode(out)).toBe("hello");
	});

	test("html-to-markdown converts HTML to markdown", async () => {
		const input = encoder.encode("<h1>Title</h1><p>Body</p>");
		const out = await applyPostProcessor("html-to-markdown", input, {}, "");
		const md = decoder.decode(out);
		expect(md).toContain("# Title");
		expect(md).toContain("Body");
	});

	test("docmd normalizes non-breaking spaces", async () => {
		const input = encoder.encode("a b");
		const out = await applyPostProcessor("docmd", input, {}, "");
		expect(decoder.decode(out)).toBe("a b");
	});

	test("shell command flavor pipes bytes through stdin", async () => {
		const dir = mkdtempSync(join(tmpdir(), "membot-pp-"));
		const path = join(dir, "uppercase.sh");
		writeFileSync(path, "#!/bin/sh\ntr a-z A-Z\n");
		chmodSync(path, 0o755);
		try {
			const input = encoder.encode("hello world");
			const out = await applyPostProcessor(
				{ command: path, args: [], timeout_ms: 10_000 },
				input,
				{},
				"",
			);
			expect(decoder.decode(out)).toBe("HELLO WORLD");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("shell command non-zero exit throws HelpfulError", async () => {
		const dir = mkdtempSync(join(tmpdir(), "membot-pp-"));
		const path = join(dir, "fail.sh");
		writeFileSync(path, "#!/bin/sh\necho oops 1>&2\nexit 3\n");
		chmodSync(path, 0o755);
		try {
			await expect(
				applyPostProcessor({ command: path, args: [], timeout_ms: 10_000 }, encoder.encode("x"), {}, ""),
			).rejects.toThrow(/exited 3.*oops/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
