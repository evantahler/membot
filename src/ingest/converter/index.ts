import type { ConvertersConfig, LlmConfig } from "../../config/schemas.ts";
import { convertDocx } from "./docx.ts";
import { convertHtml } from "./html.ts";
import { convertImage } from "./image.ts";
import { convertWithLlm } from "./llm.ts";
import { convertPdf } from "./pdf.ts";
import { convertPptx } from "./pptx.ts";
import { convertText } from "./text.ts";
import { convertXlsx } from "./xlsx.ts";

export interface ConvertResult {
	markdown: string;
	contentMimeType: "text/markdown";
}

const TEXT_MIMES = new Set(["text/markdown", "text/plain", "text/x-markdown", "text/md"]);
const HTML_MIMES = new Set(["text/html", "application/xhtml+xml"]);
const STRUCTURED_TEXT_MIMES = new Set([
	"application/json",
	"application/xml",
	"text/xml",
	"application/yaml",
	"text/yaml",
	"text/csv",
	"application/javascript",
	"application/typescript",
]);
const DOCX_MIMES = new Set(["application/vnd.openxmlformats-officedocument.wordprocessingml.document"]);
const XLSX_MIMES = new Set([
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	"application/vnd.ms-excel",
]);
const PPTX_MIMES = new Set(["application/vnd.openxmlformats-officedocument.presentationml.presentation"]);
const PDF_MIMES = new Set(["application/pdf"]);

/**
 * Convert raw bytes to a markdown surrogate via mime-dispatched native
 * libraries. The LLM is used as a normalizer for structured text (JSON,
 * XML, YAML, CSV, etc.) and as a captioner for embedded images inside
 * HTML/DOCX — never as a translator of opaque binary bytes, because that
 * path hallucinates. Unknown binaries return a deterministic placeholder.
 * Always returns markdown — even for binary types — so the chunker /
 * embedder pipeline never has to branch on the source mime.
 */
export async function convert(
	bytes: Uint8Array,
	mimeType: string,
	source: string,
	llm: LlmConfig,
	converters: ConvertersConfig,
): Promise<ConvertResult> {
	const mt = mimeType.toLowerCase();

	if (TEXT_MIMES.has(mt)) {
		return { markdown: convertText(bytes), contentMimeType: "text/markdown" };
	}

	if (HTML_MIMES.has(mt)) {
		return { markdown: await convertHtml(bytes, llm, converters), contentMimeType: "text/markdown" };
	}

	if (DOCX_MIMES.has(mt)) {
		return { markdown: await convertDocx(bytes, llm, converters), contentMimeType: "text/markdown" };
	}

	if (XLSX_MIMES.has(mt)) {
		return { markdown: await convertXlsx(bytes), contentMimeType: "text/markdown" };
	}

	if (PPTX_MIMES.has(mt)) {
		return { markdown: await convertPptx(bytes), contentMimeType: "text/markdown" };
	}

	if (PDF_MIMES.has(mt)) {
		// Capture byteLength before convertPdf — unpdf detaches the underlying
		// ArrayBuffer, leaving bytes.byteLength at 0 afterward.
		const inputBytes = bytes.byteLength;
		const markdown = await convertPdf(bytes);
		return {
			markdown: markdown || `(scanned PDF, ${inputBytes} bytes — no recognizable text)`,
			contentMimeType: "text/markdown",
		};
	}

	if (mt.startsWith("image/")) {
		return { markdown: await convertImage(bytes, mt, llm), contentMimeType: "text/markdown" };
	}

	if (STRUCTURED_TEXT_MIMES.has(mt)) {
		const raw = convertText(bytes);
		const md = await convertWithLlm(raw, mt, source, llm);
		return { markdown: md || raw, contentMimeType: "text/markdown" };
	}

	// Unknown binary: return a deterministic placeholder. We intentionally do
	// NOT ship a base64 sample to the LLM — the first few KB of an opaque
	// binary (zip headers, font tables, image magic bytes) carry no usable
	// signal, and asking Claude to "convert this to markdown" reliably
	// produces fabricated content invented from the filename. Better to say
	// nothing than to hallucinate.
	return {
		markdown: `(unknown binary, ${mt}, ${bytes.byteLength} bytes)`,
		contentMimeType: "text/markdown",
	};
}
