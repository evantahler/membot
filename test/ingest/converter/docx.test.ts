import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { convertDocx } from "../../../src/ingest/converter/docx.ts";

const NO_LLM = {
	anthropic_api_key: "",
	converter_model: "",
	chunker_model: "",
	describer_model: "",
	vision_model: "",
	describer_skip_when_titled: true,
};

const CONVERTERS = { max_inline_image_captions: 5 };

describe("convertDocx", () => {
	test("inlines an embedded image as a caption block, never as a data URI", async () => {
		const bytes = new Uint8Array(readFileSync("test/fixtures/sample-with-image.docx"));
		const md = await convertDocx(bytes, NO_LLM, CONVERTERS);

		expect(md).not.toContain("data:image");
		expect(md).not.toContain("base64");
		expect(md).toContain("Lead paragraph");
		expect(md).toContain("Trailing paragraph");
		expect(md).toContain("<!-- image: architecture diagram -->");
		expect(md).toContain("(image, image/png");
		// Surrogate must be small now — no megabyte data-URIs leaking in.
		expect(md.length).toBeLessThan(2_000);
	});
});
