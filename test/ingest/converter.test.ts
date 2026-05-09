import { describe, expect, test } from "bun:test";
import { convertHtml } from "../../src/ingest/converter/html.ts";
import { convert } from "../../src/ingest/converter/index.ts";
import { convertText } from "../../src/ingest/converter/text.ts";
import { deterministicDescription } from "../../src/ingest/describer.ts";

const NO_LLM = {
	anthropic_api_key: "",
	converter_model: "",
	chunker_model: "",
	describer_model: "",
	vision_model: "",
	describer_skip_when_titled: true,
};

const CONVERTERS = { max_inline_image_captions: 20 };

describe("converter dispatch", () => {
	test("text/markdown passes through", async () => {
		const r = await convert(new TextEncoder().encode("# hi"), "text/markdown", "in", NO_LLM, CONVERTERS);
		expect(r.markdown).toBe("# hi");
	});

	test("text/plain passes through", () => {
		expect(convertText(new TextEncoder().encode("plain"))).toBe("plain");
	});

	test("text/html → markdown via turndown", async () => {
		const html = "<h1>Title</h1><p>body</p><script>nope</script><style>.x{}</style>";
		const r = await convert(new TextEncoder().encode(html), "text/html", "in", NO_LLM, CONVERTERS);
		expect(r.markdown).toContain("# Title");
		expect(r.markdown).toContain("body");
		expect(r.markdown).not.toContain("nope");
		expect(r.markdown).not.toContain(".x{}");
	});

	test("convertHtml strips noscript", async () => {
		const md = await convertHtml(new TextEncoder().encode("<noscript>nope</noscript><p>ok</p>"), NO_LLM, CONVERTERS);
		expect(md).toContain("ok");
		expect(md).not.toContain("nope");
	});

	test("unknown binary without API key produces a placeholder", async () => {
		const r = await convert(new Uint8Array([0, 1, 2, 3]), "application/x-blob", "src", NO_LLM, CONVERTERS);
		expect(r.markdown).toContain("unknown binary");
	});

	test("structured text without API key falls back to raw text", async () => {
		const json = `{"a": 1}`;
		const r = await convert(new TextEncoder().encode(json), "application/json", "src", NO_LLM, CONVERTERS);
		expect(r.markdown).toContain('"a"');
	});
});

describe("deterministicDescription", () => {
	test("uses first heading when present", () => {
		const md = "# Auth Notes\n\nSome body content here.";
		const d = deterministicDescription("docs/auth.md", "text/markdown", md);
		expect(d).toContain("Auth Notes");
	});

	test("falls back to mime + size for binaries", () => {
		const d = deterministicDescription("img/x.png", "image/png", "(image, 1234 bytes)");
		expect(d).toContain("image/png");
	});

	test("returns logical path when content is empty", () => {
		const d = deterministicDescription("p.md", "text/markdown", "");
		expect(d).toContain("p.md");
	});
});
