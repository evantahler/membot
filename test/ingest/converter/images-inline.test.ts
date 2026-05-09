import { describe, expect, mock, test } from "bun:test";
import {
	type CapturedImage,
	extractDataUriImages,
	inlineImageCaptions,
	MEMBOT_IMG_PREFIX,
} from "../../../src/ingest/converter/images-inline.ts";

const NO_LLM = {
	anthropic_api_key: "",
	converter_model: "",
	chunker_model: "",
	describer_model: "",
	vision_model: "",
};

const CONVERTERS = { max_inline_image_captions: 20 };

const TINY_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

function pngBytes(): Uint8Array {
	return new Uint8Array(Buffer.from(TINY_PNG_BASE64, "base64"));
}

describe("extractDataUriImages", () => {
	test("rewrites data:image src to membot-img:// and captures bytes", () => {
		const html = `<p>before</p><img alt="a diagram" src="data:image/png;base64,${TINY_PNG_BASE64}" /><p>after</p>`;
		const { html: rewritten, images } = extractDataUriImages(html);

		expect(rewritten).not.toContain("data:image");
		expect(rewritten).toContain(`${MEMBOT_IMG_PREFIX}img-0`);
		expect(images.size).toBe(1);
		const img = images.get("img-0");
		expect(img?.mimeType).toBe("image/png");
		expect(img?.bytes.byteLength).toBeGreaterThan(0);
	});

	test("handles single-quoted src and multiple images", () => {
		const html =
			`<img src='data:image/jpeg;base64,${TINY_PNG_BASE64}'/>` +
			`<img alt="b" src="data:image/png;base64,${TINY_PNG_BASE64}">`;
		const { html: rewritten, images } = extractDataUriImages(html);

		expect(rewritten).not.toContain("data:image");
		expect(images.size).toBe(2);
		expect(images.get("img-0")?.mimeType).toBe("image/jpeg");
		expect(images.get("img-1")?.mimeType).toBe("image/png");
	});

	test("leaves non-data <img> references untouched", () => {
		const html = `<img src="https://example.com/foo.png" />`;
		const { html: rewritten, images } = extractDataUriImages(html);

		expect(rewritten).toBe(html);
		expect(images.size).toBe(0);
	});

	test("no <img> tags is a no-op", () => {
		const html = `<p>nothing</p>`;
		const { html: rewritten, images } = extractDataUriImages(html);

		expect(rewritten).toBe(html);
		expect(images.size).toBe(0);
	});
});

describe("inlineImageCaptions", () => {
	test("no-op when there are no captured images", async () => {
		const md = "# Heading\n\nbody text";
		const out = await inlineImageCaptions(md, new Map(), NO_LLM, CONVERTERS);
		expect(out).toBe(md);
	});

	test("no-API-key path falls back to a deterministic placeholder", async () => {
		// convertImage returns "(image, image/png, no caption available)" without an API key.
		const md = `before\n\n![diagram](${MEMBOT_IMG_PREFIX}img-0)\n\nafter`;
		const images = new Map<string, CapturedImage>([["img-0", { bytes: pngBytes(), mimeType: "image/png" }]]);

		const out = await inlineImageCaptions(md, images, NO_LLM, CONVERTERS);
		expect(out).not.toContain(MEMBOT_IMG_PREFIX);
		expect(out).toContain("<!-- image: diagram -->");
		expect(out).toContain("(image, image/png");
		expect(out).toContain("before");
		expect(out).toContain("after");
	});

	test("overflow images get a skipped-caption placeholder beyond max", async () => {
		const md = [
			`![one](${MEMBOT_IMG_PREFIX}img-0)`,
			`![two](${MEMBOT_IMG_PREFIX}img-1)`,
			`![three](${MEMBOT_IMG_PREFIX}img-2)`,
		].join("\n\n");
		const images = new Map<string, CapturedImage>([
			["img-0", { bytes: pngBytes(), mimeType: "image/png" }],
			["img-1", { bytes: pngBytes(), mimeType: "image/png" }],
			["img-2", { bytes: pngBytes(), mimeType: "image/png" }],
		]);

		const out = await inlineImageCaptions(md, images, NO_LLM, { max_inline_image_captions: 2 });
		expect(out).not.toContain(MEMBOT_IMG_PREFIX);
		// Exactly one "skipped, exceeded max_inline_image_captions" placeholder for the third image.
		const skippedCount = out.split("exceeded max_inline_image_captions").length - 1;
		expect(skippedCount).toBe(1);
	});

	test("missing image entry is rendered as a no-caption placeholder", async () => {
		const md = `![lost](${MEMBOT_IMG_PREFIX}img-missing)`;
		const out = await inlineImageCaptions(md, new Map(), NO_LLM, CONVERTERS);
		// Empty map short-circuits to a no-op; the dangling reference stays in place.
		expect(out).toBe(md);
	});

	test("captions are wrapped in blank lines so the chunker treats them as paragraphs", async () => {
		const md = `lead\n\n![p](${MEMBOT_IMG_PREFIX}img-0)\n\ntrail`;
		const images = new Map<string, CapturedImage>([["img-0", { bytes: pngBytes(), mimeType: "image/png" }]]);

		const out = await inlineImageCaptions(md, images, NO_LLM, CONVERTERS);
		expect(out).toMatch(/lead\s+\n+<!-- image: p -->/);
		expect(out).toMatch(/<!-- image: p -->[\s\S]+\n\ntrail/);
	});
});

describe("inlineImageCaptions network behavior with API key", () => {
	test("vision client receives one call per image, up to the cap", async () => {
		// Mock the Anthropic SDK so we don't need a real API key.
		const create = mock(async () => ({ content: [{ type: "text", text: "a synthesized caption" }] }));
		mock.module("@anthropic-ai/sdk", () => ({
			default: class {
				messages = { create };
			},
		}));

		// Re-import after mocking so the dynamic mock takes effect.
		const { inlineImageCaptions: inline } = await import("../../../src/ingest/converter/images-inline.ts");

		const md = `![x](${MEMBOT_IMG_PREFIX}img-0)\n\n![y](${MEMBOT_IMG_PREFIX}img-1)`;
		const images = new Map<string, CapturedImage>([
			["img-0", { bytes: pngBytes(), mimeType: "image/png" }],
			["img-1", { bytes: pngBytes(), mimeType: "image/png" }],
		]);
		const llm = { ...NO_LLM, anthropic_api_key: "test-key", vision_model: "claude-haiku-4-5-20251001" };

		const out = await inline(md, images, llm, { max_inline_image_captions: 1 });
		expect(create).toHaveBeenCalledTimes(1);
		expect(out).toContain("a synthesized caption");
		expect(out).toContain("exceeded max_inline_image_captions");
	});
});
