import type { KeywordHit } from "./keyword.ts";
import type { SemanticHit } from "./semantic.ts";

export interface FusedHit {
	logical_path: string;
	version_id: string;
	chunk_index: number;
	snippet: string;
	score: number;
	semantic_score: number | null;
	keyword_score: number | null;
	/**
	 * The full embedded/indexed string for this chunk (path + description +
	 * breadcrumb + body). Carried so the reranker can score the same text the
	 * retrievers matched on; the search operation strips it before returning.
	 */
	search_text: string;
}

const SNIPPET_MAX = 300;
/** Chars of context shown before the first matched term in a centered snippet. */
const SNIPPET_LEAD = 100;

/**
 * Reciprocal-rank fusion of semantic and keyword hit lists. Each result is
 * keyed by `(logical_path, version_id, chunk_index)` so the same chunk
 * appearing in both lists gets one fused score = sum of its RRF scores.
 *
 * `semanticWeight` (default 0.5) lets callers bias fusion toward one signal:
 * the semantic side's RRF contribution is multiplied by `semanticWeight`,
 * the keyword side's by `1 - semanticWeight`. With the default, a chunk that
 * tops both lists scores exactly the same as before; with `semanticWeight >
 * 0.5`, a chunk that ranks only on the semantic side can outrank a chunk
 * that only earned BM25 hits via incidental token overlap.
 *
 * `terms` (optional) are the user's query tokens; when provided, each hit's
 * snippet is centered on the first term occurrence in the chunk instead of
 * always showing the chunk's first 300 chars — the match is frequently in
 * the middle of the chunk, and a snippet that doesn't show it reads as a
 * false positive.
 *
 * The returned `score` is normalized to [0,1] by dividing by the theoretical
 * max fused RRF (`1/(k+1)` regardless of `semanticWeight`, since the per-side
 * weights sum to 1). 1.0 = top-1 on both signals; a chunk top-1 on only the
 * semantic list reads as `semanticWeight`.
 */
export function fuseRRF(
	semantic: SemanticHit[],
	keyword: KeywordHit[],
	options: { k?: number; limit: number; semanticWeight?: number; terms?: string[] },
): FusedHit[] {
	const k = options.k ?? 60;
	const wSem = options.semanticWeight ?? 0.5;
	const wKw = 1 - wSem;
	const maxRrf = 1 / (k + 1);
	const merged = new Map<
		string,
		{
			logical_path: string;
			version_id: string;
			chunk_index: number;
			snippet: string;
			rrf: number;
			semantic_score: number | null;
			keyword_score: number | null;
			search_text: string;
		}
	>();

	const keyOf = (lp: string, v: string, ci: number) => `${lp}::${v}::${ci}`;

	for (let i = 0; i < semantic.length; i++) {
		const hit = semantic[i];
		if (!hit) continue;
		const key = keyOf(hit.logical_path, hit.version_id, hit.chunk_index);
		const rrf = wSem / (k + i + 1);
		const existing = merged.get(key);
		if (existing) {
			existing.rrf += rrf;
			existing.semantic_score = round(hit.score);
		} else {
			merged.set(key, {
				logical_path: hit.logical_path,
				version_id: hit.version_id,
				chunk_index: hit.chunk_index,
				snippet: makeSnippet(hit.chunk_content, options.terms),
				rrf,
				semantic_score: round(hit.score),
				keyword_score: null,
				search_text: hit.search_text,
			});
		}
	}

	for (let i = 0; i < keyword.length; i++) {
		const hit = keyword[i];
		if (!hit) continue;
		const key = keyOf(hit.logical_path, hit.version_id, hit.chunk_index);
		const rrf = wKw / (k + i + 1);
		const existing = merged.get(key);
		if (existing) {
			existing.rrf += rrf;
			existing.keyword_score = round(hit.score);
		} else {
			merged.set(key, {
				logical_path: hit.logical_path,
				version_id: hit.version_id,
				chunk_index: hit.chunk_index,
				snippet: makeSnippet(hit.chunk_content, options.terms),
				rrf,
				semantic_score: null,
				keyword_score: round(hit.score),
				search_text: hit.search_text,
			});
		}
	}

	const all = [...merged.values()].sort((a, b) => b.rrf - a.rrf).slice(0, options.limit);
	return all.map((h) => ({
		logical_path: h.logical_path,
		version_id: h.version_id,
		chunk_index: h.chunk_index,
		snippet: h.snippet,
		score: round(h.rrf / maxRrf),
		semantic_score: h.semantic_score,
		keyword_score: h.keyword_score,
		search_text: h.search_text,
	}));
}

/**
 * Build a ≤300-char snippet from a chunk body. With query `terms`, the
 * snippet window is centered on the earliest term occurrence (with
 * `SNIPPET_LEAD` chars of leading context); without terms — or when none
 * match — it falls back to the chunk head. Ellipses mark truncation on
 * either end so the agent can tell a snippet from a complete chunk.
 */
export function makeSnippet(content: string, terms?: string[]): string {
	let start = 0;
	if (terms && terms.length > 0) {
		const lower = content.toLowerCase();
		let earliest = -1;
		for (const term of terms) {
			const idx = lower.indexOf(term.toLowerCase());
			if (idx !== -1 && (earliest === -1 || idx < earliest)) earliest = idx;
		}
		if (earliest > SNIPPET_LEAD) {
			start = earliest - SNIPPET_LEAD;
			// Snap forward to the next word boundary so the snippet doesn't
			// open mid-word.
			const space = content.indexOf(" ", start);
			if (space !== -1 && space < earliest) start = space + 1;
		}
	}
	const end = Math.min(content.length, start + SNIPPET_MAX);
	const head = start > 0 ? "…" : "";
	const tail = end < content.length ? "…" : "";
	return `${head}${content.slice(start, end)}${tail}`;
}

/**
 * Enforce per-file diversity on a score-ordered hit list: first pass keeps
 * at most `maxPerFile` hits per logical_path, then remaining slots backfill
 * (in score order) from the overflow so the caller always gets `limit` hits
 * when enough exist — a path-prefix search inside one file is capped only
 * when other files could take the slot instead. `maxPerFile <= 0` disables
 * the cap.
 */
export function diversify<T extends { logical_path: string }>(hits: T[], maxPerFile: number, limit: number): T[] {
	if (maxPerFile <= 0 || hits.length <= limit) return hits.slice(0, limit);
	const kept: T[] = [];
	const overflow: T[] = [];
	const perFile = new Map<string, number>();
	for (const hit of hits) {
		const n = perFile.get(hit.logical_path) ?? 0;
		if (n < maxPerFile && kept.length < limit) {
			perFile.set(hit.logical_path, n + 1);
			kept.push(hit);
		} else {
			overflow.push(hit);
		}
	}
	// Backfill keeps diversity order: the capped selection first, overflow
	// after, both internally score-ordered — the top of the list stays the
	// best chunk of each of the best files.
	for (const hit of overflow) {
		if (kept.length >= limit) break;
		kept.push(hit);
	}
	return kept;
}

/**
 * Tokenize a user query/pattern into snippet-centering terms: lowercase
 * alphanumeric tokens ≥3 chars, minus a tiny stopword list, deduped, capped
 * at 10. This drives snippet windows only — never matching or scoring.
 */
export function extractSnippetTerms(text: string): string[] {
	const tokens = text
		.toLowerCase()
		.split(/[^a-z0-9_]+/)
		.filter((t) => t.length >= 3 && !SNIPPET_STOPWORDS.has(t));
	return [...new Set(tokens)].slice(0, 10);
}

const SNIPPET_STOPWORDS = new Set([
	"the",
	"and",
	"for",
	"that",
	"with",
	"this",
	"from",
	"what",
	"when",
	"where",
	"which",
	"who",
	"how",
	"does",
	"why",
	"are",
	"was",
	"were",
	"can",
	"could",
	"should",
	"would",
	"will",
	"into",
	"about",
	"than",
	"then",
	"them",
	"they",
	"their",
	"your",
	"you",
	"our",
	"its",
	"has",
	"have",
	"had",
	"not",
	"but",
	"all",
	"any",
]);

function round(n: number): number {
	return Math.round(n * 10000) / 10000;
}
