import type { ChunkerConfig } from "../config/schemas.ts";
import { DEFAULTS } from "../constants.ts";

export interface Chunk {
	index: number;
	content: string;
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

/** Re-chunk any chunks larger than `maxChars`, preserving order and reindexing. */
export function enforceMaxChunkSize(chunks: Chunk[], maxChars: number = DEFAULTS.CHUNKER_MAX_CHARS): Chunk[] {
	const out: Chunk[] = [];
	for (const c of chunks) {
		if (c.content.length <= maxChars) {
			out.push({ index: out.length, content: c.content });
			continue;
		}
		for (const piece of splitText(c.content, maxChars)) {
			out.push({ index: out.length, content: piece });
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
 * Deterministic chunker. Splits on paragraph/line/hard boundaries to a
 * target size, then enforces a hard max-size after overlap is added. The
 * LLM chunker is a separate code path opted into via config; this is the
 * default and what tests rely on for stability.
 */
export function chunkDeterministic(content: string, config: ChunkerConfig): Chunk[] {
	if (content.length < SHORT_CONTENT_THRESHOLD) {
		return [{ index: 0, content }];
	}
	const initial = splitText(content, config.target_chars).map((c, i) => ({ index: i, content: c }));
	const sized = enforceMaxChunkSize(initial, config.max_chars);
	const withOverlap = addOverlapToChunks(sized);
	return enforceMaxChunkSize(withOverlap, config.max_chars);
}
