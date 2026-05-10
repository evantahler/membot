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
 * as the `<description>` line in chunks.search_text. When the file is
 * self-describing (markdown/text with a clear H1 in the opening) and the
 * `describer_skip_when_titled` flag is on, returns the title-derived
 * description without calling the LLM. Falls back to a deterministic
 * heuristic when no API key is configured so the pipeline still produces
 * a non-empty description offline.
 */
export async function describe(
	logicalPath: string,
	mimeType: string,
	surrogate: string,
	llm: LlmConfig,
): Promise<string> {
	if (llm.describer_skip_when_titled) {
		const titled = tryTitleDescription(mimeType, surrogate);
		if (titled) {
			logger.debug(`describer: using title-derived description for ${logicalPath}`);
			return titled;
		}
	}
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

const TEXTUAL_MIMES = new Set(["application/json", "application/yaml", "application/x-yaml"]);

/**
 * Returns a title-derived description when the surrogate is "self-describing"
 * markdown/text — a clear H1 within the first 40 non-blank lines, of
 * reasonable length. Returns null otherwise so the caller falls through to
 * the LLM. Skipping the LLM for files that already have a human-written
 * heading is the main throughput win during bulk ingest.
 */
export function tryTitleDescription(mimeType: string, surrogate: string): string | null {
	if (!mimeType.startsWith("text/") && !TEXTUAL_MIMES.has(mimeType)) return null;
	const lines = surrogate.split(/\r?\n/);
	let nonBlank = 0;
	let heading: string | null = null;
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		nonBlank += 1;
		if (nonBlank > 40) break;
		const m = trimmed.match(/^#\s+(.+?)\s*#*$/);
		if (m?.[1]) {
			heading = m[1].trim();
			break;
		}
	}
	if (!heading) return null;
	if (heading.length < 5 || heading.length > 200) return null;
	const body = surrogate
		.replace(/^#\s+.+$/m, "")
		.trim()
		.slice(0, 200)
		.replace(/\s+/g, " ")
		.trim();
	return body ? `${heading} — ${body}` : heading;
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
