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

/**
 * Build the markdown surrogate for an image: an LLM-generated caption
 * (when an API key is available) folded together with any text recovered
 * by Tesseract OCR. Falls back to OCR-only or a deterministic placeholder
 * when no API key is set.
 */
export async function convertImage(bytes: Uint8Array, mimeType: string, llm: LlmConfig): Promise<string> {
	const captionPromise = describeImage(bytes, mimeType, llm);
	const ocrPromise = ocrImage(bytes);
	const [caption, ocrText] = await Promise.all([captionPromise, ocrPromise]);

	const sections: string[] = [];
	if (caption) sections.push(caption);
	if (ocrText) sections.push(`## Text detected via OCR\n\n${ocrText}`);
	if (sections.length === 0) sections.push(`(image, ${mimeType}, no caption available)`);
	return sections.join("\n\n");
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
