import { describe, expect, test } from "bun:test";
import { diversify, extractSnippetTerms, fuseRRF, makeSnippet } from "../../src/search/hybrid.ts";
import type { KeywordHit } from "../../src/search/keyword.ts";
import type { SemanticHit } from "../../src/search/semantic.ts";

function semHit(path: string, idx: number, score: number, content = "x"): SemanticHit {
	return {
		logical_path: path,
		version_id: "2024-01-01T00:00:00.000Z",
		chunk_index: idx,
		chunk_content: content,
		search_text: content,
		score,
	};
}

function kwHit(path: string, idx: number, score: number, content = "x"): KeywordHit {
	return {
		logical_path: path,
		version_id: "2024-01-01T00:00:00.000Z",
		chunk_index: idx,
		chunk_content: content,
		search_text: content,
		score,
	};
}

describe("fuseRRF", () => {
	test("dedupes by (path, version, chunk) and sums RRF", () => {
		const sem = [semHit("a.md", 0, 0.9), semHit("b.md", 0, 0.8)];
		const kw = [kwHit("a.md", 0, 12), kwHit("c.md", 0, 5)];
		const fused = fuseRRF(sem, kw, { limit: 10 });
		const a = fused.find((h) => h.logical_path === "a.md");
		const b = fused.find((h) => h.logical_path === "b.md");
		const c = fused.find((h) => h.logical_path === "c.md");
		expect(a?.semantic_score).not.toBeNull();
		expect(a?.keyword_score).not.toBeNull();
		expect(b?.keyword_score).toBeNull();
		expect(c?.semantic_score).toBeNull();
		// "a.md" matched by both should score at least as high as either alone.
		expect(a?.score).toBeGreaterThan(b?.score ?? 0);
		expect(a?.score).toBeGreaterThan(c?.score ?? 0);
	});

	test("respects limit", () => {
		const sem = Array.from({ length: 30 }, (_, i) => semHit(`p${i}.md`, 0, 1 - i / 100));
		const fused = fuseRRF(sem, [], { limit: 5 });
		expect(fused).toHaveLength(5);
	});

	test("returns rank-ordered results", () => {
		const sem = [semHit("first", 0, 0.99), semHit("second", 0, 0.95), semHit("third", 0, 0.5)];
		const fused = fuseRRF(sem, [], { limit: 10 });
		expect(fused.map((f) => f.logical_path)).toEqual(["first", "second", "third"]);
	});

	test("normalizes score to [0,1]: top-1 on both lists ≈ 1.0", () => {
		const sem = [semHit("a.md", 0, 0.9)];
		const kw = [kwHit("a.md", 0, 12)];
		const fused = fuseRRF(sem, kw, { limit: 10 });
		expect(fused[0]?.score).toBeCloseTo(1, 3);
	});

	test("normalizes score to [0,1]: top-1 on one list ≈ 0.5", () => {
		const sem = [semHit("a.md", 0, 0.9)];
		const fused = fuseRRF(sem, [], { limit: 10 });
		expect(fused[0]?.score).toBeCloseTo(0.5, 3);
	});

	test("semanticWeight=1.0 ignores keyword signal entirely", () => {
		// "kw-only" leads on BM25 but has no semantic hit; "sem-only" only has semantic.
		const sem = [semHit("sem-only", 0, 0.9)];
		const kw = [kwHit("kw-only", 0, 999)];
		const fused = fuseRRF(sem, kw, { limit: 10, semanticWeight: 1 });
		expect(fused[0]?.logical_path).toBe("sem-only");
		expect(fused[0]?.score).toBeCloseTo(1, 3);
		const kwOnly = fused.find((h) => h.logical_path === "kw-only");
		expect(kwOnly?.score).toBe(0);
	});

	test("semanticWeight=0.0 ignores semantic signal entirely", () => {
		const sem = [semHit("sem-only", 0, 0.9)];
		const kw = [kwHit("kw-only", 0, 999)];
		const fused = fuseRRF(sem, kw, { limit: 10, semanticWeight: 0 });
		expect(fused[0]?.logical_path).toBe("kw-only");
		expect(fused[0]?.score).toBeCloseTo(1, 3);
		const semOnly = fused.find((h) => h.logical_path === "sem-only");
		expect(semOnly?.score).toBe(0);
	});

	test("semanticWeight tilts ranking when each chunk appears on only one list", () => {
		// "sem-doc" is rank-0 on semantic only; "kw-doc" is rank-0 on keyword only.
		// At semanticWeight=0.5 they tie; tilting either way breaks the tie predictably.
		const sem = [semHit("sem-doc", 0, 0.9)];
		const kw = [kwHit("kw-doc", 0, 12)];

		const tilted = fuseRRF(sem, kw, { limit: 10, semanticWeight: 0.7 });
		expect(tilted[0]?.logical_path).toBe("sem-doc");
		expect(tilted[1]?.logical_path).toBe("kw-doc");
		expect(tilted[0]?.score).toBeCloseTo(0.7, 3);
		expect(tilted[1]?.score).toBeCloseTo(0.3, 3);

		const flipped = fuseRRF(sem, kw, { limit: 10, semanticWeight: 0.3 });
		expect(flipped[0]?.logical_path).toBe("kw-doc");
		expect(flipped[1]?.logical_path).toBe("sem-doc");
	});

	test("semanticWeight=0.5 (default) preserves legacy ordering", () => {
		const sem = [semHit("a.md", 0, 0.9), semHit("b.md", 0, 0.8)];
		const kw = [kwHit("a.md", 0, 12), kwHit("c.md", 0, 5)];
		const withDefault = fuseRRF(sem, kw, { limit: 10 });
		const explicit = fuseRRF(sem, kw, { limit: 10, semanticWeight: 0.5 });
		expect(withDefault.map((h) => h.logical_path)).toEqual(explicit.map((h) => h.logical_path));
		for (let i = 0; i < withDefault.length; i++) {
			expect(withDefault[i]?.score).toBeCloseTo(explicit[i]?.score ?? -1, 5);
		}
	});

	test("carries search_text through for downstream reranking", () => {
		const fused = fuseRRF([semHit("a.md", 0, 0.9, "full body text")], [], { limit: 5 });
		expect(fused[0]?.search_text).toBe("full body text");
	});

	test("terms center the snippet on the first match", () => {
		const body = `${"intro filler. ".repeat(40)}the needle sentence lives here.${" tail filler.".repeat(40)}`;
		const fused = fuseRRF([semHit("a.md", 0, 0.9, body)], [], { limit: 5, terms: ["needle"] });
		expect(fused[0]?.snippet).toContain("needle");
		expect(fused[0]?.snippet.startsWith("…")).toBe(true);
	});
});

describe("makeSnippet", () => {
	test("no terms: returns the chunk head, with a tail ellipsis when truncated", () => {
		const out = makeSnippet("a".repeat(500));
		expect(out.length).toBeLessThanOrEqual(301);
		expect(out.endsWith("…")).toBe(true);
		expect(out.startsWith("…")).toBe(false);
	});

	test("short content returned whole, no ellipses", () => {
		expect(makeSnippet("tiny chunk")).toBe("tiny chunk");
	});

	test("match deep in the chunk pulls the window forward", () => {
		const content = `${"x ".repeat(300)}TARGET word${" y".repeat(300)}`;
		const out = makeSnippet(content, ["target"]);
		expect(out).toContain("TARGET");
		expect(out.startsWith("…")).toBe(true);
		expect(out.endsWith("…")).toBe(true);
	});

	test("match near the start keeps the chunk head", () => {
		const content = `needle early${" filler".repeat(100)}`;
		const out = makeSnippet(content, ["needle"]);
		expect(out.startsWith("…")).toBe(false);
		expect(out).toContain("needle");
	});

	test("unmatched terms fall back to the chunk head", () => {
		const out = makeSnippet("plain content here", ["zzz"]);
		expect(out).toBe("plain content here");
	});
});

describe("diversify", () => {
	const hit = (path: string, i: number) => ({ logical_path: path, i });

	test("caps hits per file and backfills from other files", () => {
		const hits = [hit("a", 0), hit("a", 1), hit("a", 2), hit("a", 3), hit("b", 4), hit("c", 5)];
		const out = diversify(hits, 2, 4);
		expect(out.map((h) => h.logical_path)).toEqual(["a", "a", "b", "c"]);
	});

	test("backfills with capped overflow when there aren't enough distinct files", () => {
		const hits = [hit("a", 0), hit("a", 1), hit("a", 2), hit("a", 3), hit("b", 4)];
		const out = diversify(hits, 2, 4);
		// 2 from a + 1 from b, then the best remaining a-hits fill the gap.
		expect(out).toHaveLength(4);
		expect(out.filter((h) => h.logical_path === "a")).toHaveLength(3);
	});

	test("cap of 0 disables diversity", () => {
		const hits = [hit("a", 0), hit("a", 1), hit("a", 2)];
		expect(diversify(hits, 0, 2).map((h) => h.i)).toEqual([0, 1]);
	});

	test("single-file result sets still fill the limit", () => {
		const hits = [hit("a", 0), hit("a", 1), hit("a", 2), hit("a", 3)];
		expect(diversify(hits, 2, 4)).toHaveLength(4);
	});
});

describe("extractSnippetTerms", () => {
	test("lowercases, drops stopwords and short tokens, dedupes", () => {
		expect(extractSnippetTerms("How does the OAuth flow work for the API")).toEqual(["oauth", "flow", "work", "api"]);
	});

	test("keeps identifier-ish tokens with underscores", () => {
		expect(extractSnippetTerms("pool_mode=transaction error")).toEqual(["pool_mode", "transaction", "error"]);
	});

	test("caps at 10 terms", () => {
		const text = Array.from({ length: 20 }, (_, i) => `term${i}`).join(" ");
		expect(extractSnippetTerms(text)).toHaveLength(10);
	});
});
