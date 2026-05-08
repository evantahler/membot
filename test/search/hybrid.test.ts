import { describe, expect, test } from "bun:test";
import { fuseRRF } from "../../src/search/hybrid.ts";
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
});
