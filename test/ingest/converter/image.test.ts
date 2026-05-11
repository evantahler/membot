import { describe, expect, mock, test } from "bun:test";
import { convertImage } from "../../../src/ingest/converter/image.ts";

const NO_LLM = {
	anthropic_api_key: "",
	converter_model: "",
	chunker_model: "",
	describer_model: "",
	vision_model: "",
	describer_skip_when_titled: true,
};

// 1×1 transparent PNG. Real bytes; valid header so the vision client accepts it.
const TINY_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
function pngBytes(): Uint8Array {
	return new Uint8Array(Buffer.from(TINY_PNG_BASE64, "base64"));
}

describe("convertImage size caps", () => {
	test("bytes over VISION_MAX_BYTES yield the over-size placeholder", async () => {
		// VISION_MAX_BYTES = 4 MB. 5 MB skips vision.
		const huge = new Uint8Array(5 * 1024 * 1024);
		const out = await convertImage(huge, "image/png", NO_LLM);
		expect(out).toContain("exceeds vision size limit");
		expect(out).toContain(`${huge.byteLength} bytes`);
	});
});

describe("convertImage with no API key", () => {
	test("tiny PNG without an API key produces the no-caption placeholder", async () => {
		const out = await convertImage(pngBytes(), "image/png", NO_LLM);
		// No API key → vision skipped → placeholder.
		expect(out).toContain("(image, image/png");
		expect(out).toContain("no caption available");
	});
});

describe("convertImage with mocked Anthropic vision", () => {
	test("vision caption is emitted when the API key is set and the mime is supported", async () => {
		const create = mock(async () => ({ content: [{ type: "text", text: "a synthesized caption" }] }));
		mock.module("@anthropic-ai/sdk", () => ({
			default: class {
				messages = { create };
			},
		}));
		// Re-import after mocking so the dynamic mock takes effect.
		const { convertImage: convertImageMocked } = await import("../../../src/ingest/converter/image.ts");

		const llm = { ...NO_LLM, anthropic_api_key: "test-key", vision_model: "claude-haiku-4-5-20251001" };
		const out = await convertImageMocked(pngBytes(), "image/png", llm);

		expect(create).toHaveBeenCalledTimes(1);
		expect(out).toContain("a synthesized caption");
	});

	test("vision is skipped for mimes not in VISION_MIMES (e.g. svg)", async () => {
		const create = mock(async () => ({ content: [{ type: "text", text: "should-not-appear" }] }));
		mock.module("@anthropic-ai/sdk", () => ({
			default: class {
				messages = { create };
			},
		}));
		const { convertImage: convertImageMocked } = await import("../../../src/ingest/converter/image.ts");

		const llm = { ...NO_LLM, anthropic_api_key: "test-key", vision_model: "claude-haiku-4-5-20251001" };
		// SVG is not in VISION_MIMES → describeImage short-circuits before calling the API.
		const out = await convertImageMocked(pngBytes(), "image/svg+xml", llm);

		expect(create).not.toHaveBeenCalled();
		expect(out).not.toContain("should-not-appear");
	});
});
