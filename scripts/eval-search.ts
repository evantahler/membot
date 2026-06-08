/**
 * Search-quality eval harness.
 *
 * Ingests the fixture corpus (test/fixtures/eval/corpus) into a fresh
 * ephemeral DuckDB per variant, runs the golden queries
 * (test/fixtures/eval/queries.json) through the same retrieval primitives
 * the search operation uses, and reports Recall@k + MRR per variant:
 *
 *   legacy   — the pre-2026-06 scheme: mean pooling, 4000/15000-char chunks,
 *              plain paragraph chunking (no breadcrumbs)
 *   current  — CLS pooling, 1400/1800-char chunks, markdown-aware chunking
 *   rerank   — `current` plus the cross-encoder pass over the fused top-30
 *
 * Usage:
 *   bun run scripts/eval-search.ts [--variant legacy,current,rerank] [--verbose] [--ci]
 *
 * `--ci` runs only the `current` variant (unless --variant is given) and
 * exits non-zero when any metric falls below CI_THRESHOLDS — that's the
 * regression gate wired into the GitHub Actions `eval` job. Thresholds sit
 * a few points below the measured baseline so cross-platform float noise
 * doesn't flake the build, while a real regression (chunking bug, pooling
 * change, search_text drift) trips it.
 *
 * The harness measures retrieval only — descriptions come from the
 * deterministic (no-LLM) describer so runs are reproducible offline.
 * Embedding model weights are cached in ~/.membot/models (shared with the
 * real membot install) so repeat runs don't re-download.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChunkerConfig } from "../src/config/schemas.ts";
import { LlmConfigSchema } from "../src/config/schemas.ts";
import { defaultMembotHome } from "../src/constants.ts";
import { insertChunksForVersion, rebuildFts } from "../src/db/chunks.ts";
import type { DbConnection } from "../src/db/connection.ts";
import { openDb } from "../src/db/connection.ts";
import { insertVersion, millisIso } from "../src/db/files.ts";
import { chunkDeterministic } from "../src/ingest/chunker.ts";
import { describe } from "../src/ingest/describer.ts";
import { embed, embedSingle, setEmbeddingCacheDir } from "../src/ingest/embedder.ts";
import { buildSearchText } from "../src/ingest/search-text.ts";
import { diversify, extractSnippetTerms, fuseRRF } from "../src/search/hybrid.ts";
import { searchKeyword } from "../src/search/keyword.ts";
import { rerankScores } from "../src/search/rerank.ts";
import { searchSemantic } from "../src/search/semantic.ts";

interface GoldenQuery {
	query: string;
	expect: string;
	kind: "deep" | "paraphrase" | "keyword" | "meta";
	/**
	 * A substring that must appear in a top-3 hit's text for the search to
	 * count as having surfaced the ANSWER (not just the right document).
	 * This is the metric that exposes embedding truncation: a doc can rank
	 * #1 via BM25/description while the answer-bearing chunk never surfaces.
	 */
	answer?: string;
}

interface Variant {
	name: string;
	pooling: "cls" | "mean";
	chunker: ChunkerConfig;
	rerank: boolean;
}

const VARIANTS: Variant[] = [
	{
		name: "legacy",
		pooling: "mean",
		chunker: { mode: "deterministic", target_chars: 4000, max_chars: 15000, markdown_aware: false },
		rerank: false,
	},
	{
		name: "current",
		pooling: "cls",
		chunker: { mode: "deterministic", target_chars: 1400, max_chars: 1800, markdown_aware: true },
		rerank: false,
	},
	{
		name: "rerank",
		pooling: "cls",
		chunker: { mode: "deterministic", target_chars: 1400, max_chars: 1800, markdown_aware: true },
		rerank: true,
	},
];

const LIMIT = 10;
const CANDIDATE_DEPTH = 30;
const SEMANTIC_WEIGHT = 0.6;
const MAX_PER_FILE = 3;

/**
 * Regression gate for `--ci`, applied to the `current` variant. Baseline as
 * of 2026-06 (40 queries, 17 docs): R@1 95.0%, R@3 100%, MRR 0.975,
 * ans@3 100%, sem@3 95.0%. Thresholds leave a few points of slack for
 * cross-platform numeric noise; a genuine pipeline regression costs more
 * than that.
 */
const CI_THRESHOLDS = {
	recallAt1: 0.9,
	recallAt3: 0.95,
	mrr: 0.93,
	ansAt3: 0.95,
	semAnsAt3: 0.9,
} as const;

interface QueryResult {
	query: GoldenQuery;
	rank: number; // 1-based rank of the expected doc, 0 = not in top LIMIT
	ansHybrid: boolean | null; // answer substring in a top-3 hybrid hit (null = no answer defined)
	ansSemantic: boolean | null; // answer substring in a top-3 raw semantic chunk
}

interface Metrics {
	label: string;
	n: number;
	recallAt1: number;
	recallAt3: number;
	recallAt5: number;
	mrr: number;
	nAns: number;
	ansAt3: number | null; // hybrid answer@3 over queries with an answer
	semAnsAt3: number | null; // semantic-only answer@3 — isolates vector quality
}

/** Load every corpus doc as { logicalPath, content }. */
async function loadCorpus(corpusDir: string): Promise<Array<{ logicalPath: string; content: string }>> {
	const docs: Array<{ logicalPath: string; content: string }> = [];
	const glob = new Bun.Glob("**/*.md");
	for await (const rel of glob.scan({ cwd: corpusDir })) {
		docs.push({ logicalPath: rel.replaceAll("\\", "/"), content: readFileSync(join(corpusDir, rel), "utf8") });
	}
	docs.sort((a, b) => a.logicalPath.localeCompare(b.logicalPath));
	return docs;
}

/** Ingest the corpus into `db` under one variant's chunking + pooling scheme. */
async function ingestCorpus(
	db: DbConnection,
	docs: Array<{ logicalPath: string; content: string }>,
	variant: Variant,
): Promise<number> {
	// No API key → deterministic title-derived descriptions, reproducible offline.
	const llm = LlmConfigSchema.parse({});
	let chunkTotal = 0;
	for (let i = 0; i < docs.length; i++) {
		const doc = docs[i];
		if (!doc) continue;
		const versionId = millisIso(1_700_000_000_000 + i);
		const description = await describe(doc.logicalPath, "text/markdown", doc.content, llm);
		const chunks = chunkDeterministic(doc.content, variant.chunker);
		const searchTexts = chunks.map((c) => buildSearchText(doc.logicalPath, description, c.content, c.context));
		const vectors = await embed(searchTexts, undefined, { pooling: variant.pooling });
		await insertVersion(db, {
			logical_path: doc.logicalPath,
			version_id: versionId,
			source_type: "local",
			content: doc.content,
			description,
			mime_type: "text/markdown",
		});
		await insertChunksForVersion(
			db,
			doc.logicalPath,
			versionId,
			chunks.map((c, idx) => ({
				chunk_index: c.index,
				chunk_content: c.content,
				search_text: searchTexts[idx] ?? "",
				embedding: vectors[idx] ?? [],
				context: c.context ?? null,
			})),
		);
		chunkTotal += chunks.length;
	}
	await rebuildFts(db);
	return chunkTotal;
}

/** Run one golden query through the same retrieval path the search operation uses. */
async function runQuery(db: DbConnection, q: GoldenQuery, variant: Variant): Promise<QueryResult> {
	const queryVec = await embedSingle(q.query, undefined, { kind: "query", pooling: variant.pooling });
	const semantic = await searchSemantic(db, queryVec, { limit: LIMIT * 5 });
	const keyword = await searchKeyword(db, q.query, { limit: LIMIT * 5 });
	const terms = extractSnippetTerms(q.query);
	const fused = fuseRRF(semantic, keyword, { limit: CANDIDATE_DEPTH, semanticWeight: SEMANTIC_WEIGHT, terms });

	let ordered = fused;
	if (variant.rerank && fused.length > 0) {
		const scores = await rerankScores(
			q.query,
			fused.map((h) => h.search_text),
		);
		ordered = fused
			.map((h, i) => ({ ...h, _rr: scores[i] ?? 0 }))
			.sort((a, b) => b._rr - a._rr)
			.map(({ _rr, ...h }) => h);
	}

	const hits = diversify(ordered, MAX_PER_FILE, LIMIT);
	const rank = hits.findIndex((h) => h.logical_path === q.expect) + 1;

	let ansHybrid: boolean | null = null;
	let ansSemantic: boolean | null = null;
	if (q.answer) {
		ansHybrid = hits.slice(0, 3).some((h) => h.search_text.includes(q.answer ?? ""));
		ansSemantic = semantic.slice(0, 3).some((h) => h.search_text.includes(q.answer ?? ""));
	}
	return { query: q, rank, ansHybrid, ansSemantic };
}

/** Aggregate ranks into Recall@k, MRR, and answer@3 rates. */
function computeMetrics(label: string, results: QueryResult[]): Metrics {
	const n = results.length;
	const within = (k: number) => results.filter((r) => r.rank > 0 && r.rank <= k).length / n;
	const mrr = results.reduce((acc, r) => acc + (r.rank > 0 ? 1 / r.rank : 0), 0) / n;
	const withAns = results.filter((r) => r.ansHybrid !== null);
	const rate = (pick: (r: QueryResult) => boolean | null) =>
		withAns.length === 0 ? null : withAns.filter((r) => pick(r) === true).length / withAns.length;
	return {
		label,
		n,
		recallAt1: within(1),
		recallAt3: within(3),
		recallAt5: within(5),
		mrr,
		nAns: withAns.length,
		ansAt3: rate((r) => r.ansHybrid),
		semAnsAt3: rate((r) => r.ansSemantic),
	};
}

function pct(x: number | null): string {
	return (x === null ? "—" : `${(x * 100).toFixed(1)}%`).padStart(6);
}

function row(m: Metrics): string {
	return `| ${m.label.padEnd(22)} | ${String(m.n).padStart(2)} | ${pct(m.recallAt1)} | ${pct(m.recallAt3)} | ${pct(m.recallAt5)} | ${m.mrr.toFixed(3).padStart(5)} | ${pct(m.ansAt3)} | ${pct(m.semAnsAt3)} |`;
}

async function main(): Promise<void> {
	const args = new Set(process.argv.slice(2));
	const verbose = args.has("--verbose");
	const ci = args.has("--ci");
	const variantArg = process.argv.find((a) => a.startsWith("--variant"));
	const wanted = variantArg
		? new Set((variantArg.split("=")[1] ?? process.argv[process.argv.indexOf(variantArg) + 1] ?? "").split(","))
		: ci
			? new Set(["current"])
			: null;
	const variants = wanted ? VARIANTS.filter((v) => wanted.has(v.name)) : VARIANTS;

	setEmbeddingCacheDir(join(defaultMembotHome(), "models"));

	const fixturesDir = join(import.meta.dir, "..", "test", "fixtures", "eval");
	const docs = await loadCorpus(join(fixturesDir, "corpus"));
	const queries = JSON.parse(readFileSync(join(fixturesDir, "queries.json"), "utf8")) as GoldenQuery[];
	console.log(
		`corpus: ${docs.length} docs · golden queries: ${queries.length} · variants: ${variants.map((v) => v.name).join(", ")}\n`,
	);

	const tmp = mkdtempSync(join(tmpdir(), "membot-eval-"));
	const header = `| ${"variant".padEnd(22)} |  n | ${"R@1".padStart(6)} | ${"R@3".padStart(6)} | ${"R@5".padStart(6)} | ${"MRR".padStart(5)} | ${"ans@3".padStart(6)} | ${"sem@3".padStart(6)} |`;
	const divider = `|${"-".repeat(24)}|----|--------|--------|--------|-------|--------|--------|`;
	const tableRows: string[] = [];
	const gateFailures: string[] = [];

	try {
		for (const variant of variants) {
			const started = Date.now();
			const db = await openDb(join(tmp, `${variant.name}.duckdb`));
			const chunkCount = await ingestCorpus(db, docs, variant);

			const results: QueryResult[] = [];
			for (const q of queries) {
				results.push(await runQuery(db, q, variant));
			}
			await db.close();

			const overall = computeMetrics(variant.name, results);
			tableRows.push(row(overall));
			if (ci && variant.name === "current") {
				for (const [metric, min] of Object.entries(CI_THRESHOLDS)) {
					const actual = overall[metric as keyof typeof CI_THRESHOLDS];
					if (actual !== null && actual < min) {
						gateFailures.push(`${metric}: ${(actual * 100).toFixed(1)}% < required ${(min * 100).toFixed(0)}%`);
					}
				}
			}
			for (const kind of ["deep", "paraphrase", "keyword", "meta"] as const) {
				const subset = results.filter((r) => r.query.kind === kind);
				if (subset.length > 0) tableRows.push(row(computeMetrics(`  ${variant.name}/${kind}`, subset)));
			}

			const misses = results.filter((r) => r.rank !== 1);
			console.log(
				`${variant.name}: ${chunkCount} chunks, ${((Date.now() - started) / 1000).toFixed(1)}s, ${results.length - misses.length}/${results.length} @ rank 1`,
			);
			if (verbose) {
				for (const m of misses) {
					console.log(
						`  rank=${m.rank === 0 ? "miss" : m.rank} [${m.query.kind}] "${m.query.query}" → ${m.query.expect}`,
					);
				}
				for (const m of results.filter((r) => r.ansHybrid === false || r.ansSemantic === false)) {
					console.log(
						`  answer ${m.ansHybrid ? "" : "hybrid✗ "}${m.ansSemantic ? "" : "sem✗"} [${m.query.kind}] "${m.query.query}" (needs "${m.query.answer}")`,
					);
				}
			}
		}
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}

	console.log(`\n${header}\n${divider}`);
	for (const r of tableRows) console.log(r);

	if (ci) {
		if (gateFailures.length > 0) {
			console.error(`\neval gate FAILED:\n${gateFailures.map((f) => `  - ${f}`).join("\n")}`);
			process.exit(1);
		}
		console.log("\neval gate passed");
	}
}

await main();
