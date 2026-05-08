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
 * The returned `score` is normalized to [0,1] by dividing by the theoretical
 * max RRF (`2/(k+1)`, achieved when a chunk is rank-0 on both lists). This
 * preserves ordering — division is monotonic — but makes the displayed value
 * interpretable: 1.0 = top-1 on both signals, ~0.5 = top-1 on one.
 */
export function fuseRRF(
	semantic: SemanticHit[],
	keyword: KeywordHit[],
	options: { k?: number; limit: number },
): FusedHit[] {
	const k = options.k ?? 60;
	const maxRrf = 2 / (k + 1);
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
		const rrf = 1 / (k + i + 1);
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
		const rrf = 1 / (k + i + 1);
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
