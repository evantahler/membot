import { extractText, getDocumentProxy } from "unpdf";
import { logger } from "../../output/logger.ts";

/**
 * Extract the text layer from a PDF using unpdf and render each page as
 * a `## Page N` markdown section. Returns an empty string on failure or
 * for PDFs without an extractable text layer; the caller is responsible
 * for emitting a placeholder when that happens.
 */
export async function convertPdf(bytes: Uint8Array): Promise<string> {
	try {
		const pdf = await getDocumentProxy(bytes);
		const { text } = await extractText(pdf, { mergePages: false });
		const pages: string[] = Array.isArray(text) ? text : [String(text)];
		return pages
			.map((p, i) => `## Page ${i + 1}\n\n${p.trim()}`)
			.filter((p) => p.length > 0)
			.join("\n\n");
	} catch (err) {
		logger.warn(`pdf: text extraction failed (${err instanceof Error ? err.message : String(err)})`);
		return "";
	}
}
