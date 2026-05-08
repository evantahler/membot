import { z } from "zod";
import { embedSingle } from "../ingest/embedder.ts";
import { colors } from "../output/formatter.ts";
import { fuseRRF } from "../search/hybrid.ts";
import { searchKeyword } from "../search/keyword.ts";
import { searchSemantic } from "../search/semantic.ts";
import { defineOperation } from "./types.ts";

export const searchOperation = defineOperation({
	name: "membot_search",
	cliName: "search",
	bashEquivalent: "grep -r + semantic-search",
	description: `Hybrid search over the context store. Pass \`query\` (natural language → semantic) and/or \`pattern\` (keyword/BM25); pass both for the strongest signal — hits matched by both float to the top via reciprocal rank fusion. Searches the CURRENT version of every file by default; set \`include_history=true\` to also search older versions. This is the primary discovery tool — prefer it over membot_read+scan.`,
	inputSchema: z.object({
		query: z.string().optional().describe("Natural-language query for semantic search"),
		pattern: z.string().optional().describe("Keyword query for BM25 search"),
		mode: z.enum(["hybrid", "semantic", "keyword"]).default("hybrid").describe("Search mode"),
		path_prefix: z.string().optional().describe("Restrict to logical paths starting with this prefix"),
		limit: z.number().default(10).describe("Max hits to return"),
		include_history: z.boolean().default(false).describe("Also search older versions (default: current only)"),
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
			}),
		),
		mode: z.string(),
	}),
	cli: { positional: ["query"] },
	console_formatter: (result) => {
		if (result.hits.length === 0) {
			return colors.dim(`(no hits in ${result.mode} mode)`);
		}
		const blocks = result.hits.map((h) => {
			const parts = [`score=${h.score.toFixed(3)}`];
			if (h.semantic_score !== null) parts.push(`sem=${h.semantic_score.toFixed(3)}`);
			if (h.keyword_score !== null) parts.push(`bm25=${h.keyword_score.toFixed(2)}`);
			const head = `${colors.cyan(h.logical_path)} ${colors.dim(`v=${h.version_id}`)} ${colors.green(parts.join(" "))}`;
			const snippet = h.snippet
				.split("\n")
				.map((l) => `  ${l}`)
				.join("\n");
			return `${head}\n${colors.dim(snippet)}`;
		});
		return `${blocks.join("\n\n")}\n${colors.dim(`${result.hits.length} hit${result.hits.length === 1 ? "" : "s"} in ${result.mode} mode`)}`;
	},
	handler: async (input, ctx) => {
		const query = input.query ?? input.pattern ?? "";
		const pattern = input.pattern ?? input.query ?? "";

		const semanticHits =
			input.mode === "keyword" || !query.trim()
				? []
				: await searchSemantic(ctx.db, await embedSingle(query, ctx.config.embedding_model), {
						limit: input.limit * 5,
						pathPrefix: input.path_prefix,
						includeHistory: input.include_history,
					});

		const keywordHits =
			input.mode === "semantic" || !pattern.trim()
				? []
				: await searchKeyword(ctx.db, pattern, { limit: input.limit * 5, pathPrefix: input.path_prefix });

		const fused = fuseRRF(semanticHits, keywordHits, { limit: input.limit });
		return { hits: fused, mode: input.mode };
	},
});
