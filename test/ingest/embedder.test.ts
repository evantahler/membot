import { describe, expect, test } from "bun:test";
import { EMBEDDING_BATCH_SIZE, EMBEDDING_DIMENSION } from "../../src/constants.ts";
import { embed, embedSingle } from "../../src/ingest/embedder.ts";

describe("embed", () => {
	test("empty input returns empty array without loading pipeline", async () => {
		const out = await embed([]);
		expect(out).toEqual([]);
	});

	test("single text returns one EMBEDDING_DIMENSION vector", async () => {
		const out = await embed(["hello world"]);
		expect(out.length).toBe(1);
		expect(out[0]?.length).toBe(EMBEDDING_DIMENSION);
	});

	test("batches inputs larger than EMBEDDING_BATCH_SIZE and preserves order", async () => {
		const n = EMBEDDING_BATCH_SIZE * 2 + 3;
		const texts = Array.from({ length: n }, (_, i) => `chunk number ${i} talks about thing ${i}`);
		const out = await embed(texts);
		expect(out.length).toBe(n);
		for (const v of out) expect(v.length).toBe(EMBEDDING_DIMENSION);

		// Same input through the batched and the single-shot path should
		// produce near-identical vectors. They aren't bit-exact because ONNX
		// can pick different fused kernels at different batch sizes, but
		// cosine similarity should be ~1.
		const single = await embedSingle(texts[5] as string);
		const batched = out[5] as number[];
		expect(batched.length).toBe(single.length);
		let dot = 0;
		for (let i = 0; i < single.length; i++) dot += (batched[i] as number) * (single[i] as number);
		expect(dot).toBeGreaterThan(0.99);
	}, 120_000);
});

describe("embedSingle", () => {
	test("returns one normalized vector", async () => {
		const v = await embedSingle("a sentence to embed");
		expect(v.length).toBe(EMBEDDING_DIMENSION);
		const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
		expect(norm).toBeCloseTo(1, 3);
	});
});
