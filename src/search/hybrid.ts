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
}

const SNIPPET_MAX = 300;

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
 * The returned `score` is normalized to [0,1] by dividing by the theoretical
 * max fused RRF (`1/(k+1)` regardless of `semanticWeight`, since the per-side
 * weights sum to 1). 1.0 = top-1 on both signals; a chunk top-1 on only the
 * semantic list reads as `semanticWeight`.
 */
export function fuseRRF(
	semantic: SemanticHit[],
	keyword: KeywordHit[],
	options: { k?: number; limit: number; semanticWeight?: number },
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
				snippet: hit.chunk_content.slice(0, SNIPPET_MAX),
				rrf,
				semantic_score: round(hit.score),
				keyword_score: null,
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
				snippet: hit.chunk_content.slice(0, SNIPPET_MAX),
				rrf,
				semantic_score: null,
				keyword_score: round(hit.score),
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
	}));
}

function round(n: number): number {
	return Math.round(n * 10000) / 10000;
}
