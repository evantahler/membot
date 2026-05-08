import mammoth from "mammoth";
import TurndownService from "turndown";

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });

/**
 * Convert a DOCX file to markdown. Mammoth gives us HTML; we then run that
 * through turndown to get clean markdown. Any conversion warnings are
 * silently dropped — they're typically about styles we don't preserve.
 */
export async function convertDocx(bytes: Uint8Array): Promise<string> {
	const buf = Buffer.from(bytes);
	const result = await mammoth.convertToHtml({ buffer: buf });
	return turndown.turndown(result.value).trim();
}
