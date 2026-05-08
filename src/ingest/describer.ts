import Anthropic from "@anthropic-ai/sdk";
import type { LlmConfig } from "../config/schemas.ts";
import { logger } from "../output/logger.ts";

const DESCRIBER_PROMPT = `You write a one-paragraph description of a file for use in a search index.

Rules:
- One paragraph, 1-3 sentences.
- Plain prose, no headings, no markdown formatting.
- Cover what the file IS and what it's ABOUT — both subject and shape.
- For images, focus on the visual subject. For documents, focus on the topic and intended reader.
- Output the description ONLY — no preamble, no quoting, no labels.`;

/**
 * Generate a one-paragraph description for the file's surrogate, used
 * as the `<description>` line in chunks.search_text. Falls back to a
 * deterministic heuristic when no API key is configured so the pipeline
 * still produces a non-empty description offline.
 */
export async function describe(
	logicalPath: string,
	mimeType: string,
	surrogate: string,
	llm: LlmConfig,
): Promise<string> {
	if (!llm.anthropic_api_key || llm.anthropic_api_key.trim() === "") {
		return deterministicDescription(logicalPath, mimeType, surrogate);
	}
	const client = new Anthropic({ apiKey: llm.anthropic_api_key });
	const sample = surrogate.slice(0, 4_000);
	try {
		const resp = await client.messages.create({
			model: llm.describer_model,
			max_tokens: 300,
			system: DESCRIBER_PROMPT,
			messages: [
				{
					role: "user",
					content: `Logical path: ${logicalPath}\nMIME type: ${mimeType}\n\nFile body:\n${sample}`,
				},
			],
		});
		const text = resp.content
			.flatMap((b) => (b.type === "text" ? [b.text] : []))
			.join("")
			.trim();
		if (!text) return deterministicDescription(logicalPath, mimeType, surrogate);
		return text;
	} catch (err) {
		logger.warn(`describer: failed (${err instanceof Error ? err.message : String(err)}) — falling back`);
		return deterministicDescription(logicalPath, mimeType, surrogate);
	}
}

/**
 * Cheap, deterministic description used when the LLM isn't available.
 * For markdown/text it's the first heading + a 200-char prefix; for
 * binaries it's `<mime> · <size> bytes`.
 */
export function deterministicDescription(logicalPath: string, mimeType: string, surrogate: string): string {
	if (mimeType.startsWith("text/") || mimeType === "application/json" || mimeType === "application/yaml") {
		const trimmed = surrogate.trim();
		const headingMatch = trimmed.match(/^#+\s+(.+)$/m);
		const heading = headingMatch?.[1]?.trim();
		const prefix = trimmed.slice(0, 200).replace(/\s+/g, " ").trim();
		if (heading && prefix) return `${heading} — ${prefix}`;
		if (heading) return heading;
		if (prefix) return prefix;
		return `${logicalPath} (${mimeType})`;
	}
	return `${mimeType} · ${surrogate.length} chars`;
}
