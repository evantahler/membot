import type { ChunkerConfig } from "../config/schemas.ts";
import { DEFAULTS } from "../constants.ts";

export interface Chunk {
	index: number;
	content: string;
	/**
	 * Heading breadcrumb scoping this chunk ("Doc Title > Section >
	 * Subsection"), set by the markdown-aware chunker. Flows into
	 * `chunks.search_text` (never into `chunk_content`) so a chunk deep in a
	 * long document still embeds the outline that scopes it. Undefined for
	 * plain-text content, preamble chunks, and short single-chunk files.
	 */
	context?: string;
}

const SHORT_CONTENT_THRESHOLD = 200;
const DEFAULT_OVERLAP_LINES = 2;

/**
 * Split text into pieces no larger than `maxChars`, preferring paragraph,
 * then line, then hard-character boundaries. Used to bound chunk size for
 * the embedding model's input window.
 */
export function splitText(text: string, maxChars: number): string[] {
	if (text.length <= maxChars) return [text];

	const paragraphs = text.split(/\n\n+/);
	if (paragraphs.length > 1) {
		const out: string[] = [];
		let buf = "";
		for (const p of paragraphs) {
			const candidate = buf ? `${buf}\n\n${p}` : p;
			if (candidate.length <= maxChars) {
				buf = candidate;
			} else {
				if (buf) out.push(buf);
				if (p.length <= maxChars) {
					buf = p;
				} else {
					out.push(...splitText(p, maxChars));
					buf = "";
				}
			}
		}
		if (buf) out.push(buf);
		return out;
	}

	const lines = text.split("\n");
	if (lines.length > 1) {
		const out: string[] = [];
		let buf = "";
		for (const line of lines) {
			const candidate = buf ? `${buf}\n${line}` : line;
			if (candidate.length <= maxChars) {
				buf = candidate;
			} else {
				if (buf) out.push(buf);
				if (line.length <= maxChars) {
					buf = line;
				} else {
					for (let i = 0; i < line.length; i += maxChars) {
						out.push(line.slice(i, i + maxChars));
					}
					buf = "";
				}
			}
		}
		if (buf) out.push(buf);
		return out;
	}

	const out: string[] = [];
	for (let i = 0; i < text.length; i += maxChars) {
		out.push(text.slice(i, i + maxChars));
	}
	return out;
}

/** Re-chunk any chunks larger than `maxChars`, preserving order, context, and reindexing. */
export function enforceMaxChunkSize(chunks: Chunk[], maxChars: number = DEFAULTS.CHUNKER_MAX_CHARS): Chunk[] {
	const out: Chunk[] = [];
	for (const c of chunks) {
		if (c.content.length <= maxChars) {
			out.push({ ...c, index: out.length });
			continue;
		}
		for (const piece of splitText(c.content, maxChars)) {
			out.push({ index: out.length, content: piece, ...(c.context !== undefined ? { context: c.context } : {}) });
		}
	}
	return out;
}

/**
 * Add overlapping lines from the end of each chunk to the start of the
 * next so retrieval still works when concepts span chunk boundaries.
 */
export function addOverlapToChunks(chunks: Chunk[], overlapLines = DEFAULT_OVERLAP_LINES): Chunk[] {
	if (chunks.length <= 1 || overlapLines <= 0) return chunks;
	return chunks.map((c, i) => {
		if (i === 0) return { ...c };
		const prev = chunks[i - 1];
		if (!prev) return { ...c };
		const overlap = prev.content.split("\n").slice(-overlapLines).join("\n");
		return { ...c, content: `${overlap}\n${c.content}` };
	});
}

/**
 * One heading-delimited slice of a markdown document. `ancestors` is the
 * stack of enclosing heading titles ABOVE this section's own heading;
 * `heading` is the section's own title (null for the pre-heading preamble).
 * `text` includes the heading line itself, so concatenating every section's
 * text with "\n" reconstructs the original document exactly.
 */
interface MarkdownSection {
	ancestors: string[];
	heading: string | null;
	text: string;
}

const ATX_HEADING = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Split markdown into heading-delimited sections, tracking the heading
 * stack for breadcrumbs. Headings inside fenced code blocks are NOT section
 * boundaries — a `# comment` in a bash snippet must not fragment the chunk
 * or corrupt the breadcrumb trail.
 */
export function parseMarkdownSections(content: string): MarkdownSection[] {
	const lines = content.split("\n");
	const sections: MarkdownSection[] = [];
	const stack: Array<{ level: number; title: string }> = [];

	let cur: MarkdownSection = { ancestors: [], heading: null, text: "" };
	let curLines: string[] = [];
	let fence: { char: string; len: number } | null = null;

	const flush = () => {
		if (curLines.length === 0) return;
		cur.text = curLines.join("\n");
		sections.push(cur);
		curLines = [];
	};

	for (const line of lines) {
		if (fence) {
			curLines.push(line);
			const m = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
			if (m?.[1] && m[1][0] === fence.char && m[1].length >= fence.len) fence = null;
			continue;
		}
		const fenceMatch = line.match(FENCE_OPEN);
		if (fenceMatch?.[1]) {
			fence = { char: fenceMatch[1][0] ?? "`", len: fenceMatch[1].length };
			curLines.push(line);
			continue;
		}
		const headingMatch = line.match(ATX_HEADING);
		if (headingMatch?.[1] && headingMatch[2]) {
			flush();
			const level = headingMatch[1].length;
			const title = headingMatch[2].trim();
			while (stack.length > 0 && (stack[stack.length - 1]?.level ?? 0) >= level) stack.pop();
			cur = { ancestors: stack.map((s) => s.title), heading: title, text: "" };
			stack.push({ level, title });
			curLines.push(line);
			continue;
		}
		curLines.push(line);
	}
	flush();
	return sections;
}

/** Join breadcrumb parts into the context string, or undefined when empty. */
function breadcrumb(parts: string[]): string | undefined {
	const joined = parts
		.map((p) => p.trim())
		.filter((p) => p !== "")
		.join(" > ");
	return joined === "" ? undefined : joined;
}

/** True when the content has at least one ATX heading outside a fenced code block. */
export function hasMarkdownHeadings(content: string): boolean {
	return parseMarkdownSections(content).some((s) => s.heading !== null);
}

/**
 * Structure-aware chunker for markdown. Sections (heading-delimited slices)
 * are greedily packed into chunks up to `target_chars`; a section is never
 * split mid-fence unless it alone exceeds the budget. Each chunk carries a
 * `context` breadcrumb of the headings enclosing its first line — the
 * heading lines themselves stay in the chunk body, so the breadcrumb only
 * names ancestors the chunk can't see. Pieces of an oversized section get
 * the section's own heading appended to their breadcrumb (the heading line
 * is only present in the first piece) plus a small line overlap.
 */
export function chunkMarkdown(content: string, config: ChunkerConfig): Chunk[] {
	const sections = parseMarkdownSections(content);
	const out: Chunk[] = [];
	let bufText = "";
	let bufContext: string | undefined;

	const flush = () => {
		if (bufText === "") return;
		out.push({ index: out.length, content: bufText, ...(bufContext !== undefined ? { context: bufContext } : {}) });
		bufText = "";
		bufContext = undefined;
	};

	for (const section of sections) {
		const candidate = bufText ? `${bufText}\n${section.text}` : section.text;
		if (candidate.length <= config.target_chars) {
			if (bufText === "") bufContext = breadcrumb(section.ancestors);
			bufText = candidate;
			continue;
		}
		flush();
		if (section.text.length <= config.target_chars) {
			bufText = section.text;
			bufContext = breadcrumb(section.ancestors);
			continue;
		}
		// Section alone exceeds the budget — split it, overlapping a couple of
		// lines between pieces so concepts spanning the cut stay findable.
		const pieces = splitText(section.text, config.target_chars).map((p, i) => ({ index: i, content: p }));
		const overlapped = addOverlapToChunks(pieces);
		const headContext = breadcrumb(section.ancestors);
		const innerContext = breadcrumb(
			section.heading !== null ? [...section.ancestors, section.heading] : section.ancestors,
		);
		for (let i = 0; i < overlapped.length; i++) {
			const piece = overlapped[i];
			if (!piece) continue;
			const context = i === 0 ? headContext : innerContext;
			out.push({ index: out.length, content: piece.content, ...(context !== undefined ? { context } : {}) });
		}
	}
	flush();
	return enforceMaxChunkSize(out, config.max_chars);
}

/**
 * Deterministic chunker. Markdown with headings goes through the
 * structure-aware path (heading-boundary splits, fence-safe, breadcrumb
 * context per chunk) unless `chunker.markdown_aware` is off; everything
 * else splits on paragraph/line/hard boundaries to the target size. A hard
 * max-size is enforced after overlap is added. The LLM chunker is a
 * separate code path opted into via config; this is the default and what
 * tests rely on for stability.
 */
export function chunkDeterministic(content: string, config: ChunkerConfig): Chunk[] {
	if (content.length < SHORT_CONTENT_THRESHOLD) {
		return [{ index: 0, content }];
	}
	if (config.markdown_aware !== false && hasMarkdownHeadings(content)) {
		return chunkMarkdown(content, config);
	}
	const initial = splitText(content, config.target_chars).map((c, i) => ({ index: i, content: c }));
	const sized = enforceMaxChunkSize(initial, config.max_chars);
	const withOverlap = addOverlapToChunks(sized);
	return enforceMaxChunkSize(withOverlap, config.max_chars);
}
