import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as XLSX from "xlsx";
import { convertHtml } from "../../src/ingest/converter/html.ts";
import { convert } from "../../src/ingest/converter/index.ts";
import { convertText } from "../../src/ingest/converter/text.ts";
import { deterministicDescription } from "../../src/ingest/describer.ts";

function loadFixture(name: string): Uint8Array {
	return new Uint8Array(readFileSync(join(import.meta.dir, "../fixtures", name)));
}

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

	test("unknown binary WITH an API key still returns the placeholder — never hallucinates", async () => {
		// Regression guard: previously, the unknown-binary path would base64
		// 4KB of opaque bytes and ask the LLM to "convert this to markdown",
		// which reliably produced fabricated content. The contract now: any
		// unhandled binary mime returns the deterministic placeholder, full
		// stop. A non-empty API key must not change the result. The
		// presence of an API key here doesn't issue a network call because
		// we never reach the LLM branch.
		const withKey = { ...NO_LLM, anthropic_api_key: "sk-test-not-real" };
		const r = await convert(
			new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 1, 2, 3]),
			"application/x-weird",
			"x.weird",
			withKey,
			CONVERTERS,
		);
		expect(r.markdown).toBe("(unknown binary, application/x-weird, 8 bytes)");
	});

	test("application/vnd.openxmlformats…presentationml.presentation routes through convertPptx", async () => {
		// Build a minimal pptx inline so we don't need to ship a fixture for
		// the dispatch test. convertPptx only reads ppt/slides/slide*.xml.
		const JSZipModule = await import("jszip");
		const JSZip = JSZipModule.default;
		const zip = new JSZip();
		zip.file(
			"ppt/slides/slide1.xml",
			`<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
       xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
	<p:cSld><p:spTree>
		<p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
		<p:txBody><a:p><a:r><a:t>DISPATCH_TOKEN_PPTX</a:t></a:r></a:p></p:txBody></p:sp>
	</p:spTree></p:cSld>
</p:sld>`,
		);
		const bytes = await zip.generateAsync({ type: "uint8array" });
		const r = await convert(
			bytes,
			"application/vnd.openxmlformats-officedocument.presentationml.presentation",
			"src",
			NO_LLM,
			CONVERTERS,
		);
		expect(r.markdown).toContain("DISPATCH_TOKEN_PPTX");
		expect(r.markdown).toContain("## Slide 1: DISPATCH_TOKEN_PPTX");
		expect(r.markdown).not.toContain("unknown binary");
	});

	test("structured text without API key falls back to raw text", async () => {
		const json = `{"a": 1}`;
		const r = await convert(new TextEncoder().encode(json), "application/json", "src", NO_LLM, CONVERTERS);
		expect(r.markdown).toContain('"a"');
	});

	test("application/pdf routes through convertPdf", async () => {
		const r = await convert(loadFixture("sample.pdf"), "application/pdf", "src", NO_LLM, CONVERTERS);
		expect(r.markdown).toContain("FIXTURE_TOKEN_42");
		expect(r.markdown).toMatch(/## Page 1/);
		expect(r.contentMimeType).toBe("text/markdown");
	});

	test("application/vnd.openxmlformats…wordprocessingml.document routes through convertDocx", async () => {
		const r = await convert(
			loadFixture("sample-with-image.docx"),
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			"src",
			NO_LLM,
			CONVERTERS,
		);
		// Sample docx contains plain text plus an embedded image; we just need
		// to confirm the dispatcher landed on convertDocx (not the LLM fallback).
		expect(r.markdown.length).toBeGreaterThan(0);
		expect(r.markdown).not.toContain("unknown binary");
		expect(r.markdown).not.toContain("data:image");
	});

	test("application/vnd.openxmlformats…spreadsheetml.sheet routes through convertXlsx", async () => {
		const wb = XLSX.utils.book_new();
		XLSX.utils.book_append_sheet(
			wb,
			XLSX.utils.aoa_to_sheet([
				["Name", "Role"],
				["Alice", "Engineer"],
			]),
			"People",
		);
		const bytes = new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }));
		const r = await convert(
			bytes,
			"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
			"src",
			NO_LLM,
			CONVERTERS,
		);
		expect(r.markdown).toContain("## People");
		expect(r.markdown).toContain("| Name | Role |");
		expect(r.markdown).toContain("| Alice | Engineer |");
	});

	test("image/* without an API key produces the no-caption placeholder", async () => {
		// 1×1 transparent PNG.
		const png = new Uint8Array(
			Buffer.from(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
				"base64",
			),
		);
		const r = await convert(png, "image/png", "src", NO_LLM, CONVERTERS);
		expect(r.markdown).toContain("(image, image/png");
		expect(r.markdown).toContain("no caption available");
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
