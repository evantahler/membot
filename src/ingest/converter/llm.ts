import Anthropic from "@anthropic-ai/sdk";
import type { LlmConfig } from "../../config/schemas.ts";
import { logger } from "../../output/logger.ts";

const CONVERTER_MAX_TOKENS = 16_384;

const CONVERTER_SYSTEM_PROMPT = `You normalize documents to clean, well-structured Markdown.

If the input is already clean, valid Markdown, return it verbatim with no edits.

Otherwise, convert it. The input mime_type is a hint, not a guarantee — verify the actual content. Common non-markdown formats:
- HTML — strip tags, scripts, styles, navigation/footer chrome.
- JSON / XML / YAML — render structure as readable Markdown.
- DocMD-like annotation formats — strip bracket annotations, map H1→#, H2→##, P→paragraph.

Rules for the output:
- Preserve all semantic content: headings, paragraphs, lists, tables, links, inline code, code blocks, blockquotes.
- Use ATX headings (#, ##, ###), fenced code blocks, GFM-style tables.
- Strip metadata headers/IDs (e.g. @document_id: ...).
- Output ONLY the Markdown. No preamble, no trailing commentary, no wrapping the entire output in a code fence.`;

/**
 * Last-resort converter: ship the raw text/binary preview to Claude and ask
 * for clean markdown. Returns the raw input unchanged when there's no API
 * key configured (the pipeline degrades to a less-clean surrogate rather
 * than failing the ingest). Does NOT run when the input is already known
 * to be markdown — caller should short-circuit that path.
 */
export async function convertWithLlm(
	content: string,
	mimeType: string,
	source: string,
	llm: LlmConfig,
): Promise<string> {
	if (!llm.anthropic_api_key || llm.anthropic_api_key.trim() === "") {
		return content;
	}
	const client = new Anthropic({ apiKey: llm.anthropic_api_key });
	try {
		const stream = client.messages.stream({
			model: llm.converter_model,
			max_tokens: CONVERTER_MAX_TOKENS,
			system: CONVERTER_SYSTEM_PROMPT,
			messages: [
				{
					role: "user",
					content: `Convert this ${mimeType} content to Markdown. Source: ${source}\n\n${content}`,
				},
			],
		});
		const final = await stream.finalMessage();
		const text = final.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
		if (!text.trim()) return content;
		return stripLeadingMarkdownFence(text);
	} catch (err) {
		logger.warn(`llm-converter: failed (${err instanceof Error ? err.message : String(err)}) — using raw input`);
		return content;
	}
}

function stripLeadingMarkdownFence(text: string): string {
	const trimmed = text.trim();
	const fenceMatch = trimmed.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/);
	if (fenceMatch?.[1]) return fenceMatch[1];
	return text;
}
