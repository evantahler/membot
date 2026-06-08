import { describe, expect, test } from "bun:test";
import type { ChunkerConfig } from "../../src/config/schemas.ts";
import {
	addOverlapToChunks,
	chunkDeterministic,
	chunkMarkdown,
	enforceMaxChunkSize,
	hasMarkdownHeadings,
	parseMarkdownSections,
	splitText,
} from "../../src/ingest/chunker.ts";

/** Shorthand for chunker configs in tests. */
function cfg(target: number, max: number, markdownAware = true): ChunkerConfig {
	return { mode: "deterministic", target_chars: target, max_chars: max, markdown_aware: markdownAware };
}

describe("chunker", () => {
	test("splitText returns single piece when small", () => {
		expect(splitText("hello", 100)).toEqual(["hello"]);
	});

	test("splitText prefers paragraph boundaries", () => {
		const text = "para1\n\npara2\n\npara3";
		const out = splitText(text, 10);
		expect(out.length).toBeGreaterThan(1);
		expect(out.join("\n\n")).toBe(text);
	});

	test("splitText falls back to lines, then hard chars", () => {
		expect(splitText("abcdefghij", 3)).toEqual(["abc", "def", "ghi", "j"]);
	});

	test("enforceMaxChunkSize splits oversize chunks and reindexes", () => {
		const chunks = [
			{ index: 0, content: "ok" },
			{ index: 1, content: "x".repeat(20) },
		];
		const out = enforceMaxChunkSize(chunks, 10);
		expect(out.length).toBeGreaterThan(2);
		expect(out.map((c) => c.index)).toEqual(out.map((_, i) => i));
	});

	test("enforceMaxChunkSize preserves context on split pieces", () => {
		const out = enforceMaxChunkSize([{ index: 0, content: "y".repeat(25), context: "Doc > Section" }], 10);
		expect(out.length).toBeGreaterThan(1);
		for (const c of out) expect(c.context).toBe("Doc > Section");
	});

	test("addOverlapToChunks prepends previous tail lines", () => {
		const chunks = [
			{ index: 0, content: "a\nb\nc" },
			{ index: 1, content: "d\ne" },
		];
		const out = addOverlapToChunks(chunks, 1);
		expect(out[1]?.content).toBe("c\nd\ne");
	});

	test("addOverlapToChunks no-op for single chunk or zero overlap", () => {
		expect(addOverlapToChunks([{ index: 0, content: "x" }], 5)).toEqual([{ index: 0, content: "x" }]);
		expect(
			addOverlapToChunks(
				[
					{ index: 0, content: "a" },
					{ index: 1, content: "b" },
				],
				0,
			),
		).toEqual([
			{ index: 0, content: "a" },
			{ index: 1, content: "b" },
		]);
	});

	test("chunkDeterministic returns single chunk for short content", () => {
		const out = chunkDeterministic("hi there", cfg(4000, 15000));
		expect(out).toEqual([{ index: 0, content: "hi there" }]);
	});

	test("chunkDeterministic produces multiple chunks for long plain content", () => {
		const text = "para\n\n".repeat(2000);
		const out = chunkDeterministic(text, cfg(200, 500));
		expect(out.length).toBeGreaterThan(1);
		for (const c of out) {
			expect(c.content.length).toBeLessThanOrEqual(500);
		}
	});

	test("chunkDeterministic is stable on same input", () => {
		const text = `${"x".repeat(300)}\n\n${"y".repeat(300)}`;
		const a = chunkDeterministic(text, cfg(200, 500));
		const b = chunkDeterministic(text, cfg(200, 500));
		expect(a).toEqual(b);
	});
});

describe("parseMarkdownSections", () => {
	test("splits at headings and tracks the breadcrumb stack", () => {
		const md = "# Title\n\nintro\n\n## Setup\n\nsetup text\n\n### Linux\n\nlinux text\n\n## Usage\n\nusage text";
		const sections = parseMarkdownSections(md);
		expect(sections.map((s) => s.heading)).toEqual(["Title", "Setup", "Linux", "Usage"]);
		expect(sections[2]?.ancestors).toEqual(["Title", "Setup"]);
		// H2 "Usage" pops "Setup" and "Linux" off the stack.
		expect(sections[3]?.ancestors).toEqual(["Title"]);
	});

	test("content before the first heading becomes a preamble section", () => {
		const md = "frontmatter-ish preamble\n\n# Real Title\n\nbody";
		const sections = parseMarkdownSections(md);
		expect(sections[0]?.heading).toBeNull();
		expect(sections[0]?.text).toContain("preamble");
	});

	test("headings inside fenced code blocks are not section boundaries", () => {
		const md = "# Doc\n\n```bash\n# this is a comment, not a heading\necho hi\n```\n\ntail";
		const sections = parseMarkdownSections(md);
		expect(sections).toHaveLength(1);
		expect(sections[0]?.text).toContain("# this is a comment");
	});

	test("concatenating section text reconstructs the document", () => {
		const md = "preamble\n\n# A\n\none\n\n## B\n\ntwo\n\n```\n# fenced\n```\n\n# C\n\nthree";
		const sections = parseMarkdownSections(md);
		expect(sections.map((s) => s.text).join("\n")).toBe(md);
	});

	test("hasMarkdownHeadings respects fences", () => {
		expect(hasMarkdownHeadings("# yes\nbody")).toBe(true);
		expect(hasMarkdownHeadings("```\n# no\n```")).toBe(false);
		expect(hasMarkdownHeadings("plain text only")).toBe(false);
	});
});

describe("chunkMarkdown", () => {
	const SECTION = (title: string, body: string) => `## ${title}\n\n${body}\n`;

	test("packs small sections together; context is the enclosing breadcrumb", () => {
		const md = `# Guide\n\nintro\n\n${SECTION("One", "a".repeat(50))}\n${SECTION("Two", "b".repeat(50))}`;
		const out = chunkMarkdown(md, cfg(4000, 15000));
		expect(out).toHaveLength(1);
		// The chunk starts at the doc preamble, which has no enclosing heading.
		expect(out[0]?.context).toBeUndefined();
	});

	test("a chunk starting at a subsection carries its ancestors as context", () => {
		const big = "x".repeat(900);
		const md = `# Guide\n\n${SECTION("One", big)}\n${SECTION("Two", big)}\n${SECTION("Three", big)}`;
		const out = chunkMarkdown(md, cfg(1000, 1500));
		expect(out.length).toBeGreaterThan(1);
		// Chunks after the first start at an H2 boundary; their ancestor is the H1.
		for (const c of out.slice(1)) {
			expect(c.context).toBe("Guide");
		}
		// Heading lines stay in the body.
		expect(out.map((c) => c.content).join("\n")).toContain("## Two");
	});

	test("an oversized section is split; later pieces include the section heading in context", () => {
		const huge = Array.from({ length: 40 }, (_, i) => `line ${i} ${"z".repeat(40)}`).join("\n");
		const md = `# Doc\n\n## Big Section\n\n${huge}`;
		const out = chunkMarkdown(md, cfg(600, 800));
		expect(out.length).toBeGreaterThan(2);
		// The piece that still holds the "## Big Section" heading line needs
		// only the ancestors; pieces after it lost the heading line, so their
		// breadcrumb includes the section's own title.
		const headIdx = out.findIndex((c) => c.content.includes("## Big Section"));
		expect(headIdx).toBeGreaterThanOrEqual(0);
		expect(out[headIdx]?.context).toBe("Doc");
		for (const c of out.slice(headIdx + 1)) {
			expect(c.context).toBe("Doc > Big Section");
		}
	});

	test("code fences are never split across chunks when sections fit", () => {
		const fence = "```js\nconst x = 1;\nconst y = 2;\n```";
		const md = `# Doc\n\n## A\n\n${"a".repeat(500)}\n\n## B\n\n${fence}\n\n## C\n\n${"c".repeat(500)}`;
		const out = chunkMarkdown(md, cfg(600, 1000));
		const withFence = out.filter((c) => c.content.includes("```"));
		// The fence opens and closes within a single chunk.
		expect(withFence).toHaveLength(1);
		expect(withFence[0]?.content.match(/```/g)).toHaveLength(2);
	});

	test("chunkDeterministic dispatches markdown to chunkMarkdown and respects markdown_aware=false", () => {
		const md = `# Doc\n\n## Section\n\n${"word ".repeat(200)}`;
		const aware = chunkDeterministic(md, cfg(400, 600, true));
		const plain = chunkDeterministic(md, cfg(400, 600, false));
		expect(aware.some((c) => c.context !== undefined)).toBe(true);
		expect(plain.every((c) => c.context === undefined)).toBe(true);
	});
});
