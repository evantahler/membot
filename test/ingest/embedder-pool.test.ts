import { afterAll, describe, expect, test } from "bun:test";
import { EMBEDDING_BATCH_SIZE, EMBEDDING_DIMENSION, EMBEDDING_MODEL } from "../../src/constants.ts";
import { embed, getEmbedderPool, setEmbedderPool } from "../../src/ingest/embedder.ts";
import { EmbedderPool, withEmbedderPool } from "../../src/ingest/embedder-pool.ts";

const TIMEOUT = 180_000;

describe("EmbedderPool", () => {
	const pools: EmbedderPool[] = [];

	afterAll(async () => {
		setEmbedderPool(null);
		await Promise.all(pools.map((p) => p.dispose()));
	});

	function makePool(workers = 2): EmbedderPool {
		const pool = new EmbedderPool(workers, EMBEDDING_MODEL);
		pools.push(pool);
		return pool;
	}

	test(
		"spawn() boots workers lazily and embed() returns dim-correct vectors",
		async () => {
			const pool = makePool(2);
			pool.spawn();
			const out = await pool.embed(["hello world", "another piece of text", "third"]);
			expect(out.length).toBe(3);
			for (const v of out) expect(v.length).toBe(EMBEDDING_DIMENSION);
		},
		TIMEOUT,
	);

	test(
		"embed splits across batches and preserves order vs single-process embed",
		async () => {
			const pool = makePool(2);
			pool.spawn();
			const n = EMBEDDING_BATCH_SIZE * 3 + 5;
			const texts = Array.from({ length: n }, (_, i) => `chunk number ${i} talks about thing ${i}`);
			const fromPool = await pool.embed(texts);
			expect(fromPool.length).toBe(n);

			// Compare a sampled vector against the single-process path. Cosine
			// similarity should be ~1; ONNX may pick different fused kernels at
			// different batch sizes, so we don't require bit-exact equality.
			const direct = await embed([texts[7] as string], EMBEDDING_MODEL, { directOnly: true });
			const a = fromPool[7] as number[];
			const b = direct[0] as number[];
			let dot = 0;
			for (let i = 0; i < a.length; i++) dot += (a[i] as number) * (b[i] as number);
			expect(dot).toBeGreaterThan(0.99);
		},
		TIMEOUT,
	);

	test(
		"onProgress is monotone and ends at total",
		async () => {
			const pool = makePool(2);
			pool.spawn();
			const n = EMBEDDING_BATCH_SIZE * 3 + 1;
			const texts = Array.from({ length: n }, (_, i) => `progress text ${i}`);
			const calls: Array<[number, number]> = [];
			await pool.embed(texts, undefined, { onProgress: (done, total) => calls.push([done, total]) });
			expect(calls.length).toBeGreaterThan(0);
			const lastCall = calls.at(-1);
			expect(lastCall?.[0]).toBe(n);
			expect(lastCall?.[1]).toBe(n);
			// Counts must be monotonically non-decreasing (parallel batches finish
			// in non-deterministic order, but `done` is summed not assigned).
			for (let i = 1; i < calls.length; i++) {
				expect(calls[i]?.[0]).toBeGreaterThanOrEqual(calls[i - 1]?.[0] ?? 0);
			}
		},
		TIMEOUT,
	);

	test(
		"warmup() primes every worker so the next real embed succeeds",
		async () => {
			const pool = makePool(2);
			pool.spawn();
			await pool.warmup();
			const out = await pool.embed(["a", "b"]);
			expect(out.length).toBe(2);
			for (const v of out) expect(v.length).toBe(EMBEDDING_DIMENSION);
		},
		TIMEOUT,
	);

	test(
		"empty input short-circuits without dispatching",
		async () => {
			const pool = makePool(2);
			pool.spawn();
			const out = await pool.embed([]);
			expect(out).toEqual([]);
		},
		TIMEOUT,
	);

	test(
		"setEmbedderPool routes top-level embed() through the pool",
		async () => {
			const pool = makePool(2);
			pool.spawn();
			let called = 0;
			const proxy = {
				embed: async (texts: string[], model?: string, opts?: { onProgress?: (d: number, t: number) => void }) => {
					called++;
					return pool.embed(texts, model, opts);
				},
			};
			setEmbedderPool(proxy);
			try {
				const out = await embed(["routed", "through", "pool"]);
				expect(out.length).toBe(3);
				expect(called).toBe(1);
			} finally {
				setEmbedderPool(null);
			}
		},
		TIMEOUT,
	);

	test(
		"directOnly bypasses a registered pool",
		async () => {
			const pool = makePool(2);
			pool.spawn();
			let called = 0;
			setEmbedderPool({
				embed: async () => {
					called++;
					return [];
				},
			});
			try {
				const out = await embed(["query text"], EMBEDDING_MODEL, { directOnly: true });
				expect(out.length).toBe(1);
				expect(out[0]?.length).toBe(EMBEDDING_DIMENSION);
				expect(called).toBe(0);
			} finally {
				setEmbedderPool(null);
			}
		},
		TIMEOUT,
	);

	test(
		"dispose kills child processes and rejects subsequent embed calls",
		async () => {
			const pool = new EmbedderPool(2, EMBEDDING_MODEL);
			pool.spawn();
			await pool.embed(["warmup"]);
			await pool.dispose();
			// Idempotent: a second dispose is fine.
			await pool.dispose();
			await expect(pool.embed(["after-dispose"])).rejects.toThrow(/after dispose/);
		},
		TIMEOUT,
	);

	test("rejects non-positive worker counts", () => {
		expect(() => new EmbedderPool(0, EMBEDDING_MODEL)).toThrow(/positive integer/);
		expect(() => new EmbedderPool(-1, EMBEDDING_MODEL)).toThrow(/positive integer/);
		expect(() => new EmbedderPool(1.5, EMBEDDING_MODEL)).toThrow(/positive integer/);
	});

	test(
		"withEmbedderPool registers + disposes a per-call pool, workers=1 short-circuits",
		async () => {
			expect(getEmbedderPool()).toBeNull();
			const out = await withEmbedderPool(2, EMBEDDING_MODEL, async () => {
				expect(getEmbedderPool()).not.toBeNull();
				return embed(["one", "two"]);
			});
			expect(out.length).toBe(2);
			for (const v of out) expect(v.length).toBe(EMBEDDING_DIMENSION);
			expect(getEmbedderPool()).toBeNull();

			// workers=1 → no pool spawned, no setEmbedderPool side effect.
			let observed: ReturnType<typeof getEmbedderPool> = "untouched" as never;
			await withEmbedderPool(1, EMBEDDING_MODEL, async () => {
				observed = getEmbedderPool();
			});
			expect(observed).toBeNull();
		},
		TIMEOUT,
	);
});
