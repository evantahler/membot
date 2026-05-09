import TurndownService from "turndown";
import type { ConvertersConfig, LlmConfig } from "../../config/schemas.ts";
import { extractDataUriImages, inlineImageCaptions } from "./images-inline.ts";

const turndown = new TurndownService({
	headingStyle: "atx",
	codeBlockStyle: "fenced",
	bulletListMarker: "-",
});

/**
 * Convert HTML bytes to markdown using turndown. Strips script/style blocks
 * before conversion so they don't leak into the chunker. Inline data-URI
 * images are extracted into their bytes and replaced with vision captions
 * via `inlineImageCaptions`; external `<img src="https://…">` references
 * are left for turndown to render normally.
 */
export async function convertHtml(bytes: Uint8Array, llm: LlmConfig, converters: ConvertersConfig): Promise<string> {
	const html = new TextDecoder("utf-8").decode(bytes);
	const cleaned = html
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<noscript[\s\S]*?<\/noscript>/gi, "");
	const { html: rewritten, images } = extractDataUriImages(cleaned);
	const md = turndown.turndown(rewritten).trim();
	return inlineImageCaptions(md, images, llm, converters);
}
