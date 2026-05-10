import { extractText, getDocumentProxy } from "unpdf";
import { logger } from "../../output/logger.ts";

export interface PdfConversion {
	markdown: string;
	textRatio: number;
	usedOcrFallback: boolean;
}

const LOW_TEXT_RATIO = 0.005; // < ~5 chars per kB → very likely scanned

/**
 * Extract the text layer from a PDF using unpdf. Returns the extracted
 * markdown and a `textRatio` (chars / file-bytes) so the dispatcher can
 * decide whether to fall through to OCR. The OCR step itself happens in
 * converter/index.ts so this module stays free of WASM dependencies.
 */
export async function convertPdf(bytes: Uint8Array): Promise<PdfConversion> {
	// Capture the input size BEFORE calling unpdf — `getDocumentProxy` detaches
	// the underlying ArrayBuffer, leaving `bytes.byteLength` at 0 afterward.
	// Without this snapshot, every PDF would compute textRatio=0 and falsely
	// trip `shouldOcrPdf` regardless of how much text was extracted.
	const inputBytes = bytes.byteLength;
	try {
		const pdf = await getDocumentProxy(bytes);
		const { text } = await extractText(pdf, { mergePages: false });
		const pages: string[] = Array.isArray(text) ? text : [String(text)];
		const md = pages
			.map((p, i) => `## Page ${i + 1}\n\n${p.trim()}`)
			.filter((p) => p.length > 0)
			.join("\n\n");
		const ratio = inputBytes === 0 ? 0 : md.length / inputBytes;
		return { markdown: md, textRatio: ratio, usedOcrFallback: false };
	} catch (err) {
		logger.warn(`pdf: text extraction failed (${err instanceof Error ? err.message : String(err)})`);
		return { markdown: "", textRatio: 0, usedOcrFallback: false };
	}
}

/** Decide whether unpdf's output is "low text ratio" enough to warrant OCR fallback. */
export function shouldOcrPdf(conversion: PdfConversion): boolean {
	return conversion.markdown.trim().length === 0 || conversion.textRatio < LOW_TEXT_RATIO;
}
