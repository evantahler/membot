import { describe, expect, test } from "bun:test";
import { addOverlapToChunks, chunkDeterministic, enforceMaxChunkSize, splitText } from "../../src/ingest/chunker.ts";

describe("chunker", () => {
	test("splitText returns single piece when small", () => {
		expect(splitText("hello", 100)).toEqual(["hello"]);
	});

	test("splitText prefers paragraph boundaries", () => {
		const text = "para1\n\npara2\n\npara3";
		const out = splitText(text, 10);
		expect(out.length).toBeGreaterThan(1);
		expect(out.join("\n\n")).toBe(text);
	});

	test("splitText falls back to lines, then hard chars", () => {
		expect(splitText("abcdefghij", 3)).toEqual(["abc", "def", "ghi", "j"]);
	});

	test("enforceMaxChunkSize splits oversize chunks and reindexes", () => {
		const chunks = [
			{ index: 0, content: "ok" },
			{ index: 1, content: "x".repeat(20) },
		];
		const out = enforceMaxChunkSize(chunks, 10);
		expect(out.length).toBeGreaterThan(2);
		expect(out.map((c) => c.index)).toEqual(out.map((_, i) => i));
	});

	test("addOverlapToChunks prepends previous tail lines", () => {
		const chunks = [
			{ index: 0, content: "a\nb\nc" },
			{ index: 1, content: "d\ne" },
		];
		const out = addOverlapToChunks(chunks, 1);
		expect(out[1]?.content).toBe("c\nd\ne");
	});

	test("addOverlapToChunks no-op for single chunk or zero overlap", () => {
		expect(addOverlapToChunks([{ index: 0, content: "x" }], 5)).toEqual([{ index: 0, content: "x" }]);
		expect(
			addOverlapToChunks(
				[
					{ index: 0, content: "a" },
					{ index: 1, content: "b" },
				],
				0,
			),
		).toEqual([
			{ index: 0, content: "a" },
			{ index: 1, content: "b" },
		]);
	});

	test("chunkDeterministic returns single chunk for short content", () => {
		const out = chunkDeterministic("hi there", { mode: "deterministic", target_chars: 4000, max_chars: 15000 });
		expect(out).toEqual([{ index: 0, content: "hi there" }]);
	});

	test("chunkDeterministic produces multiple chunks for long content", () => {
		const text = "para\n\n".repeat(2000);
		const out = chunkDeterministic(text, { mode: "deterministic", target_chars: 200, max_chars: 500 });
		expect(out.length).toBeGreaterThan(1);
		for (const c of out) {
			expect(c.content.length).toBeLessThanOrEqual(500);
		}
	});

	test("chunkDeterministic is stable on same input", () => {
		const text = `${"x".repeat(300)}\n\n${"y".repeat(300)}`;
		const a = chunkDeterministic(text, { mode: "deterministic", target_chars: 200, max_chars: 500 });
		const b = chunkDeterministic(text, { mode: "deterministic", target_chars: 200, max_chars: 500 });
		expect(a).toEqual(b);
	});
});
