/**
 * Build the exact string that gets embedded AND FTS-indexed for a chunk.
 * Format:
 *   <logical_path>
 *   <description>
 *   <blank line>
 *   <chunk_content>
 *
 * The path + description prefix lifts recall on filename-only or
 * description-only queries (e.g. "the OAuth diagram" finds an empty PNG
 * row whose body is only its caption). Stored verbatim as
 * `chunks.search_text` so retrieval consumers can return clean snippets
 * by reading `chunks.chunk_content` separately.
 */
export function buildSearchText(logicalPath: string, description: string | null, chunkContent: string): string {
	const desc = (description ?? "").trim();
	return `${logicalPath}\n${desc}\n\n${chunkContent}`;
}
