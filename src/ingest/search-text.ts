/**
 * Hard cap on the description's contribution to `search_text`. The embedded
 * string must fit bge-small's 512-token window alongside the path, the
 * heading breadcrumb, and the chunk body — an unbounded 3-sentence
 * description would eat ~100 tokens of that budget on every chunk of the
 * file. 240 chars ≈ 60 tokens keeps the lift on description-only queries
 * while leaving the window to the body. FTS indexes the same capped string,
 * so keyword search sees the identical text.
 */
const DESCRIPTION_MAX_CHARS = 240;

/**
 * Build the exact string that gets embedded AND FTS-indexed for a chunk.
 * Format:
 *   <logical_path>
 *   <description (capped at 240 chars)>
 *   <heading breadcrumb, when the chunk has one>
 *   <blank line>
 *   <chunk_content>
 *
 * The path + description prefix lifts recall on filename-only or
 * description-only queries (e.g. "the OAuth diagram" finds an empty PNG
 * row whose body is only its caption). The breadcrumb line ("Doc > Section
 * > Subsection") carries the chunk's position in the document outline, so a
 * chunk deep in a long file still embeds the headings that scope it.
 * Stored verbatim as `chunks.search_text` so retrieval consumers can return
 * clean snippets by reading `chunks.chunk_content` separately.
 */
export function buildSearchText(
	logicalPath: string,
	description: string | null,
	chunkContent: string,
	context?: string | null,
): string {
	const desc = truncateAtWord((description ?? "").trim(), DESCRIPTION_MAX_CHARS);
	const ctx = (context ?? "").trim();
	const head = ctx ? `${logicalPath}\n${desc}\n${ctx}` : `${logicalPath}\n${desc}`;
	return `${head}\n\n${chunkContent}`;
}

/**
 * Truncate `text` to at most `max` chars, cutting back to the last word
 * boundary and appending an ellipsis. Returns the input unchanged when it
 * already fits.
 */
export function truncateAtWord(text: string, max: number): string {
	if (text.length <= max) return text;
	const slice = text.slice(0, max);
	const lastSpace = slice.lastIndexOf(" ");
	const cut = lastSpace > max * 0.5 ? slice.slice(0, lastSpace) : slice;
	return `${cut.trimEnd()}…`;
}
