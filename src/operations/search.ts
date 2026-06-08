import { z } from "zod";
import { warnIfStaleEmbeddingRevision } from "../db/meta.ts";
import { HelpfulError } from "../errors.ts";
import { embedSingle } from "../ingest/embedder.ts";
import { normalizeLogicalPath } from "../ingest/ingest.ts";
import { colors } from "../output/formatter.ts";
import { diversify, extractSnippetTerms, type FusedHit, fuseRRF } from "../search/hybrid.ts";
import { searchKeyword } from "../search/keyword.ts";
import { rerankScores } from "../search/rerank.ts";
import { searchSemantic } from "../search/semantic.ts";
import { defineOperation } from "./types.ts";

/** Hard ceiling on candidates handed to the cross-encoder per query. */
const RERANK_MAX_CANDIDATES = 50;

export const searchOperation = defineOperation({
	name: "membot_search",
	cliName: "search",
	bashEquivalent: "grep -r + semantic-search",
	description: `Hybrid search over the context store. Pass \`query\` (natural language → semantic) and/or \`pattern\` (keyword/BM25); pass both for the strongest signal — hits matched by both float to the top via reciprocal rank fusion. Set \`rerank=true\` for a higher-precision (slower) pass that rescores the top candidates with a local cross-encoder. Results include at most a few chunks per file (config search.max_per_file), backfilled so you still get \`limit\` hits. Searches the CURRENT version of every file by default; set \`include_history=true\` to also search older versions. This is the primary discovery tool — prefer it over membot_read+scan.`,
	inputSchema: z.object({
		query: z
			.string()
			.optional()
			.describe(
				"Natural-language query for semantic search (e.g. 'how does auth work'). Provide at least one of `query` or `pattern`.",
			),
		pattern: z
			.string()
			.optional()
			.describe(
				"Keyword query for BM25 search — best for exact tokens, identifiers, or error strings. Provide at least one of `query` or `pattern`.",
			),
		mode: z
			.enum(["hybrid", "semantic", "keyword"])
			.default("hybrid")
			.describe(
				"`hybrid` (default) fuses both lists via RRF; `semantic` uses only `query`; `keyword` uses only `pattern`.",
			),
		path_prefix: z.string().optional().describe("Restrict to logical paths starting with this prefix"),
		limit: z.number().default(10).describe("Max hits to return"),
		include_history: z.boolean().default(false).describe("Also search older versions (default: current only)"),
		rerank: z
			.boolean()
			.optional()
			.describe(
				"Rescore top candidates with a local cross-encoder before returning (higher precision, slower; first use downloads the model). Defaults to config search.rerank.",
			),
	}),
	outputSchema: z.object({
		hits: z.array(
			z.object({
				logical_path: z.string(),
				version_id: z.string(),
				chunk_index: z.number(),
				snippet: z.string(),
				score: z
					.number()
					.describe(
						"Normalized fusion score in [0,1]; 1.0 = chunk was top-1 on both semantic and keyword lists, ~0.5 = top-1 on one",
					),
				semantic_score: z
					.number()
					.nullable()
					.describe("Cosine similarity from the semantic side (0-1), or null if not matched"),
				keyword_score: z
					.number()
					.nullable()
					.describe("Raw BM25 score from the keyword side (unbounded), or null if not matched"),
				rerank_score: z
					.number()
					.nullable()
					.describe(
						"Cross-encoder relevance (0-1) when reranking was on — results are ordered by this; null otherwise",
					),
			}),
		),
		mode: z.string(),
		reranked: z.boolean().describe("True when the cross-encoder pass ran and ordered these results"),
	}),
	cli: { positional: ["query"] },
	console_formatter: (result) => {
		if (result.hits.length === 0) {
			return colors.dim(`(no hits in ${result.mode} mode)`);
		}
		const blocks = result.hits.map((h) => {
			const parts = [`score=${h.score.toFixed(3)}`];
			if (h.rerank_score !== null) parts.push(`rr=${h.rerank_score.toFixed(3)}`);
			if (h.semantic_score !== null) parts.push(`sem=${h.semantic_score.toFixed(3)}`);
			if (h.keyword_score !== null) parts.push(`bm25=${h.keyword_score.toFixed(2)}`);
			const head = `${colors.cyan(h.logical_path)} ${colors.dim(`v=${h.version_id}`)} ${colors.green(parts.join(" "))}`;
			const snippet = h.snippet
				.split("\n")
				.map((l) => `  ${l}`)
				.join("\n");
			return `${head}\n${colors.dim(snippet)}`;
		});
		const summary = `${result.hits.length} hit${result.hits.length === 1 ? "" : "s"} in ${result.mode} mode${result.reranked ? " (reranked)" : ""}`;
		return `${blocks.join("\n\n")}\n${colors.dim(summary)}`;
	},
	handler: async (input, ctx) => {
		const query = input.query ?? input.pattern ?? "";
		const pattern = input.pattern ?? input.query ?? "";

		if (!query.trim() && !pattern.trim()) {
			throw new HelpfulError({
				kind: "input_error",
				message: "search requires a query or pattern",
				hint: 'Pass a natural-language query (e.g. `membot search "oauth flow"`) or a keyword pattern (e.g. `membot search --pattern OAuth`).',
			});
		}

		const pathPrefix = input.path_prefix ? normalizeLogicalPath(input.path_prefix) : undefined;
		const rerankEnabled = input.rerank ?? ctx.config.search.rerank;
		// Retrieve deeper than `limit`: fusion reorders, the diversity cap
		// drops same-file pile-ups, and the reranker needs a candidate pool
		// worth rescoring.
		const candidateDepth = Math.min(RERANK_MAX_CANDIDATES, Math.max(input.limit * 3, 20));

		const semanticHits =
			input.mode === "keyword" || !query.trim()
				? []
				: await searchSemantic(ctx.db, await embedSingle(query, ctx.config.embedding_model, { kind: "query" }), {
						limit: input.limit * 5,
						pathPrefix,
						includeHistory: input.include_history,
					});
		if (input.mode !== "keyword" && query.trim()) {
			await warnIfStaleEmbeddingRevision(ctx.db);
		}

		const keywordHits =
			input.mode === "semantic" || !pattern.trim()
				? []
				: await searchKeyword(ctx.db, pattern, { limit: input.limit * 5, pathPrefix });

		const terms = extractSnippetTerms(pattern.trim() !== "" ? pattern : query);
		const fused = fuseRRF(semanticHits, keywordHits, {
			limit: candidateDepth,
			semanticWeight: ctx.config.search.semantic_weight,
			terms,
		});

		let ordered: Array<FusedHit & { rerank_score: number | null }>;
		let reranked = false;
		if (rerankEnabled && fused.length > 0) {
			const scores = await rerankScores(
				query.trim() !== "" ? query : pattern,
				fused.map((h) => h.search_text),
				ctx.config.search.rerank_model,
			);
			ordered = fused
				.map((h, i) => ({ ...h, rerank_score: round4(scores[i] ?? 0) }))
				.sort((a, b) => (b.rerank_score ?? 0) - (a.rerank_score ?? 0));
			reranked = true;
		} else {
			ordered = fused.map((h) => ({ ...h, rerank_score: null }));
		}

		const final = diversify(ordered, ctx.config.search.max_per_file, input.limit);
		return {
			hits: final.map((h) => ({
				logical_path: h.logical_path,
				version_id: h.version_id,
				chunk_index: h.chunk_index,
				snippet: h.snippet,
				score: h.score,
				semantic_score: h.semantic_score,
				keyword_score: h.keyword_score,
				rerank_score: h.rerank_score,
			})),
			mode: input.mode,
			reranked,
		};
	},
});

/** Round to 4 decimal places for stable, compact JSON output. */
function round4(n: number): number {
	return Math.round(n * 10000) / 10000;
}
