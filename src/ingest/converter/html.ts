import TurndownService from "turndown";

const turndown = new TurndownService({
	headingStyle: "atx",
	codeBlockStyle: "fenced",
	bulletListMarker: "-",
});

/**
 * Convert HTML bytes to markdown using turndown. Strips script/style blocks
 * before conversion so they don't leak into the chunker.
 */
export function convertHtml(bytes: Uint8Array): string {
	const html = new TextDecoder("utf-8").decode(bytes);
	const cleaned = html
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<noscript[\s\S]*?<\/noscript>/gi, "");
	return turndown.turndown(cleaned).trim();
}
