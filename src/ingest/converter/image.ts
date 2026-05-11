import Anthropic from "@anthropic-ai/sdk";
import type { LlmConfig } from "../../config/schemas.ts";
import { logger } from "../../output/logger.ts";

const VISION_PROMPT = `Describe this image as a one-paragraph caption suitable for retrieval. Focus on:
- The subject and any people / objects / diagrams visible
- Visible text content if present
- The visual style (screenshot, photograph, diagram, chart, etc.)

Output the caption only, no preamble.`;

const VISION_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** Anthropic vision rejects images > 5MB; stay under that with margin. */
const VISION_MAX_BYTES = 4 * 1024 * 1024;
/** Hard wall-clock so a stuck network call never freezes ingest. */
const SUBTASK_TIMEOUT_MS = 60_000;

/**
 * Build the markdown surrogate for an image: an LLM-generated caption
 * when an API key is available and the mime is supported. Falls back
 * to a deterministic placeholder otherwise.
 */
export async function convertImage(bytes: Uint8Array, mimeType: string, llm: LlmConfig): Promise<string> {
	if (bytes.byteLength > VISION_MAX_BYTES) {
		return `(image, ${mimeType}, ${bytes.byteLength} bytes — exceeds vision size limit, no caption available)`;
	}
	const caption = await withTimeout(describeImage(bytes, mimeType, llm), SUBTASK_TIMEOUT_MS, "vision");
	if (caption) return caption;
	return `(image, ${mimeType}, no caption available)`;
}

/**
 * Race a promise against a timer so a stuck network call never freezes
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
