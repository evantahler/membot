import Anthropic from "@anthropic-ai/sdk";
import type { LlmConfig } from "../../config/schemas.ts";
import { logger } from "../../output/logger.ts";
import { ocrImage } from "./ocr.ts";

const VISION_PROMPT = `Describe this image as a one-paragraph caption suitable for retrieval. Focus on:
- The subject and any people / objects / diagrams visible
- Visible text content if present
- The visual style (screenshot, photograph, diagram, chart, etc.)

Output the caption only, no preamble.`;

const VISION_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** Anthropic vision rejects images > 5MB; stay under that with margin. */
const VISION_MAX_BYTES = 4 * 1024 * 1024;
/** Tesseract is roughly linear in pixel count; bail past this byte size to avoid pathological hangs. */
const OCR_MAX_BYTES = 8 * 1024 * 1024;
/** Hard wall-clock for either subtask so a stuck network call never freezes ingest. */
const SUBTASK_TIMEOUT_MS = 60_000;

/**
 * Build the markdown surrogate for an image: an LLM-generated caption
 * (when an API key is available) folded together with any text recovered
 * by Tesseract OCR. Falls back to OCR-only or a deterministic placeholder
 * when no API key is set.
 */
export async function convertImage(bytes: Uint8Array, mimeType: string, llm: LlmConfig): Promise<string> {
	const captionPromise =
		bytes.byteLength <= VISION_MAX_BYTES
			? withTimeout(describeImage(bytes, mimeType, llm), SUBTASK_TIMEOUT_MS, "vision")
			: Promise.resolve("");
	const ocrPromise =
		bytes.byteLength <= OCR_MAX_BYTES
			? withTimeout(ocrImage(bytes), SUBTASK_TIMEOUT_MS, "ocr")
			: Promise.resolve("");
	const [caption, ocrText] = await Promise.all([captionPromise, ocrPromise]);

	const sections: string[] = [];
	if (caption) sections.push(caption);
	if (ocrText) sections.push(`## Text detected via OCR\n\n${ocrText}`);
	if (sections.length === 0) {
		const note =
			bytes.byteLength > VISION_MAX_BYTES
				? `(image, ${mimeType}, ${bytes.byteLength} bytes — exceeds vision size limit, no caption available)`
				: `(image, ${mimeType}, no caption available)`;
		sections.push(note);
	}
	return sections.join("\n\n");
}

/**
 * Race a promise against a timer so a stuck network call (vision) or a
 * pathological CPU-bound job (OCR on a multi-megapixel image) never freezes
 * the whole conversion pipeline. Logs a warning when the timer wins.
 */
async function withTimeout<T extends string>(p: Promise<T>, ms: number, label: string): Promise<T | ""> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<"">((resolve) => {
		timer = setTimeout(() => {
			logger.warn(`image: ${label} timed out after ${ms}ms`);
			resolve("");
		}, ms);
	});
	try {
		return await Promise.race([p, timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/**
 * Single-shot vision call asking Claude to caption an image. Returns the
 * caption text or an empty string when the API key is missing or the
 * MIME type isn't accepted by the vision endpoint.
 */
async function describeImage(bytes: Uint8Array, mimeType: string, llm: LlmConfig): Promise<string> {
	if (!llm.anthropic_api_key || llm.anthropic_api_key.trim() === "") return "";
	if (!VISION_MIMES.has(mimeType)) return "";

	const client = new Anthropic({ apiKey: llm.anthropic_api_key });
	const base64 = Buffer.from(bytes).toString("base64");
	try {
		const resp = await client.messages.create({
			model: llm.vision_model,
			max_tokens: 500,
			messages: [
				{
					role: "user",
					content: [
						{
							type: "image",
							source: {
								type: "base64",
								media_type: mimeType as "image/png" | "image/jpeg" | "image/gif" | "image/webp",
								data: base64,
							},
						},
						{ type: "text", text: VISION_PROMPT },
					],
				},
			],
		});
		const text = resp.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
		return text.trim();
	} catch (err) {
		logger.warn(`vision: caption failed (${err instanceof Error ? err.message : String(err)})`);
		return "";
	}
}
