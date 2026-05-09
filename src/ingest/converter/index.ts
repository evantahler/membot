import type { LlmConfig } from "../../config/schemas.ts";
import { convertDocx } from "./docx.ts";
import { convertHtml } from "./html.ts";
import { convertImage } from "./image.ts";
import { convertWithLlm } from "./llm.ts";
import { ocrImage } from "./ocr.ts";
import { convertPdf, shouldOcrPdf } from "./pdf.ts";
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
const PDF_MIMES = new Set(["application/pdf"]);

/**
 * Convert raw bytes to a markdown surrogate via mime-dispatched native
 * libraries first, with an LLM fallback when no native converter applies
 * and an Anthropic API key is configured. Always returns markdown — even
 * for binary types — so the chunker / embedder pipeline never has to
 * branch on the source mime.
 */
export async function convert(
	bytes: Uint8Array,
	mimeType: string,
	source: string,
	llm: LlmConfig,
): Promise<ConvertResult> {
	const mt = mimeType.toLowerCase();

	if (TEXT_MIMES.has(mt)) {
		return { markdown: convertText(bytes), contentMimeType: "text/markdown" };
	}

	if (HTML_MIMES.has(mt)) {
		return { markdown: convertHtml(bytes), contentMimeType: "text/markdown" };
	}

	if (DOCX_MIMES.has(mt)) {
		return { markdown: await convertDocx(bytes), contentMimeType: "text/markdown" };
	}

	if (XLSX_MIMES.has(mt)) {
		return { markdown: await convertXlsx(bytes), contentMimeType: "text/markdown" };
	}

	if (PDF_MIMES.has(mt)) {
		const conversion = await convertPdf(bytes);
		if (!shouldOcrPdf(conversion)) {
			return { markdown: conversion.markdown, contentMimeType: "text/markdown" };
		}
		const ocrText = await ocrPdfBytes(bytes);
		const merged = [conversion.markdown, ocrText ? `## Text detected via OCR\n\n${ocrText}` : ""]
			.filter(Boolean)
			.join("\n\n");
		return {
			markdown: merged || `(scanned PDF, ${bytes.byteLength} bytes — no recognizable text)`,
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

	// Last resort: try LLM conversion with a base64 sample (truncated) so we
	// at least produce something for unknown binary types. Without an API
	// key we fall straight through to a deterministic placeholder.
	if (!llm.anthropic_api_key || llm.anthropic_api_key.trim() === "") {
		return {
			markdown: `(unknown binary, ${mt}, ${bytes.byteLength} bytes)`,
			contentMimeType: "text/markdown",
		};
	}
	const sample = sampleAsText(bytes, mt);
	const md = await convertWithLlm(sample, mt, source, llm);
	if (md && md.trim().length > 0 && md !== sample) {
		return { markdown: md, contentMimeType: "text/markdown" };
	}
	return { markdown: `(unknown binary, ${mt}, ${bytes.byteLength} bytes)`, contentMimeType: "text/markdown" };
}

/**
 * Render a small slice of unknown-binary bytes as a base64 sample so the
 * LLM converter has something to look at without us shipping a 50MB blob.
 */
function sampleAsText(bytes: Uint8Array, mimeType: string): string {
	const slice = bytes.slice(0, 4096);
	const b64 = Buffer.from(slice).toString("base64");
	return `Binary content of type ${mimeType}, ${bytes.byteLength} bytes total. First 4096 bytes (base64):\n\n${b64}`;
}

/**
 * Tesseract over a PDF's bytes is unhelpful (it's not an image). For a real
 * scanned-PDF OCR pipeline we'd rasterize each page first; for now this
 * function exists as a hook and returns an empty string so the dispatcher
 * still produces a usable surrogate.
 */
async function ocrPdfBytes(_bytes: Uint8Array): Promise<string> {
	return "";
}

export { ocrImage };
