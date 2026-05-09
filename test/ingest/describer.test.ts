import { describe, expect, mock, test } from "bun:test";
import { tryTitleDescription } from "../../src/ingest/describer.ts";

const NO_LLM_TITLED_ON = {
	anthropic_api_key: "",
	converter_model: "",
	chunker_model: "",
	describer_model: "",
	vision_model: "",
	describer_skip_when_titled: true,
};

describe("tryTitleDescription", () => {
	test("markdown with H1 returns title + body prefix", () => {
		const out = tryTitleDescription("text/markdown", "# Project Plan\n\nThis document outlines the rollout.");
		expect(out).toContain("Project Plan");
		expect(out).toContain("This document outlines the rollout");
	});

	test("plain text mime with H1 still qualifies", () => {
		const out = tryTitleDescription("text/plain", "# Notes from standup\n\nThings discussed.");
		expect(out).toContain("Notes from standup");
	});

	test("application/json is treated as textual", () => {
		const out = tryTitleDescription("application/json", '# Config schema\n\n{"a": 1}');
		expect(out).toContain("Config schema");
	});

	test("returns null when no H1 is present", () => {
		expect(tryTitleDescription("text/markdown", "Just a paragraph with no heading.")).toBeNull();
	});

	test("returns null for non-text mimes", () => {
		expect(tryTitleDescription("application/pdf", "# Title\n\nbody")).toBeNull();
		expect(tryTitleDescription("image/png", "# Title\n\nbody")).toBeNull();
	});

	test("rejects too-short headings", () => {
		expect(tryTitleDescription("text/markdown", "# hi\n\nbody")).toBeNull();
	});

	test("rejects too-long headings", () => {
		const long = `# ${"x".repeat(250)}\n\nbody`;
		expect(tryTitleDescription("text/markdown", long)).toBeNull();
	});

	test("ignores H2/H3 — only H1 qualifies", () => {
		expect(tryTitleDescription("text/markdown", "## Subhead\n\nbody")).toBeNull();
	});

	test("falls through when H1 only appears beyond the first 40 non-blank lines", () => {
		const filler = Array.from({ length: 45 }, (_, i) => `line ${i}`).join("\n");
		const out = tryTitleDescription("text/markdown", `${filler}\n\n# Late title\n\nbody`);
		expect(out).toBeNull();
	});

	test("strips trailing closing-hash characters from atx-style headings", () => {
		const out = tryTitleDescription("text/markdown", "# Project Plan ##\n\nbody text");
		expect(out).toContain("Project Plan");
		expect(out).not.toContain("##");
	});
});

describe("describe()", () => {
	test("uses title-based path without calling Anthropic when flag is on and content has H1", async () => {
		const create = mock(async () => ({ content: [{ type: "text", text: "should not be used" }] }));
		mock.module("@anthropic-ai/sdk", () => ({
			default: class {
				messages = { create };
			},
		}));
		const { describe: describeFn } = await import("../../src/ingest/describer.ts");
		const llm = { ...NO_LLM_TITLED_ON, anthropic_api_key: "test-key" };
		const out = await describeFn("notes/plan.md", "text/markdown", "# Q3 Plan\n\nintro paragraph", llm);
		expect(out).toContain("Q3 Plan");
		expect(create).toHaveBeenCalledTimes(0);
	});

	test("falls through to LLM for titled content when describer_skip_when_titled is false", async () => {
		const create = mock(async () => ({ content: [{ type: "text", text: "an LLM-written summary" }] }));
		mock.module("@anthropic-ai/sdk", () => ({
			default: class {
				messages = { create };
			},
		}));
		const { describe: describeFn } = await import("../../src/ingest/describer.ts");
		const llm = { ...NO_LLM_TITLED_ON, describer_skip_when_titled: false, anthropic_api_key: "test-key" };
		const out = await describeFn("notes/plan.md", "text/markdown", "# Q3 Plan\n\nintro paragraph", llm);
		expect(out).toBe("an LLM-written summary");
		expect(create).toHaveBeenCalledTimes(1);
	});

	test("falls through to LLM for binary content even with flag on", async () => {
		const create = mock(async () => ({ content: [{ type: "text", text: "vision-derived caption" }] }));
		mock.module("@anthropic-ai/sdk", () => ({
			default: class {
				messages = { create };
			},
		}));
		const { describe: describeFn } = await import("../../src/ingest/describer.ts");
		const llm = { ...NO_LLM_TITLED_ON, anthropic_api_key: "test-key" };
		const out = await describeFn("img/diagram.png", "image/png", "binary surrogate body", llm);
		expect(out).toBe("vision-derived caption");
		expect(create).toHaveBeenCalledTimes(1);
	});
});
