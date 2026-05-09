import { describe, expect, test } from "bun:test";
import { pMap } from "../../src/ingest/concurrency.ts";

describe("pMap", () => {
	test("preserves input order in results", async () => {
		const out = await pMap([10, 5, 30, 15, 1], 3, async (n) => {
			await new Promise((r) => setTimeout(r, n));
			return n * 2;
		});
		expect(out.map((r) => (r.ok ? r.value : null))).toEqual([20, 10, 60, 30, 2]);
	});

	test("respects the concurrency cap", async () => {
		let inFlight = 0;
		let maxInFlight = 0;
		await pMap(
			Array.from({ length: 20 }, (_, i) => i),
			4,
			async () => {
				inFlight += 1;
				maxInFlight = Math.max(maxInFlight, inFlight);
				await new Promise((r) => setTimeout(r, 5));
				inFlight -= 1;
			},
		);
		expect(maxInFlight).toBeGreaterThan(1);
		expect(maxInFlight).toBeLessThanOrEqual(4);
	});

	test("captures worker rejections without aborting siblings", async () => {
		const out = await pMap([1, 2, 3], 2, async (n) => {
			if (n === 2) throw new Error("nope");
			return n;
		});
		expect(out[0]).toEqual({ ok: true, value: 1 });
		expect(out[1]?.ok).toBe(false);
		expect(out[2]).toEqual({ ok: true, value: 3 });
	});

	test("clamps concurrency to at least 1", async () => {
		const out = await pMap([1, 2, 3], 0, async (n) => n);
		expect(out.map((r) => (r.ok ? r.value : null))).toEqual([1, 2, 3]);
	});

	test("handles empty input", async () => {
		const out = await pMap([], 5, async (n) => n);
		expect(out).toEqual([]);
	});
});
