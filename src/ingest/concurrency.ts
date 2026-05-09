/**
 * Run `worker(item)` over `items` with at most `concurrency` workers in
 * flight at a time. Results are returned in input order. Worker rejections
 * are caught and surfaced as `{ ok: false, error }` entries instead of
 * aborting the batch — partial failures are normal during bulk ingest, and
 * the caller decides how to render them per-entry.
 */
export async function pMap<T, R>(
	items: readonly T[],
	concurrency: number,
	worker: (item: T, index: number) => Promise<R>,
): Promise<Array<{ ok: true; value: R } | { ok: false; error: unknown }>> {
	const limit = Math.max(1, Math.floor(concurrency));
	const results: Array<{ ok: true; value: R } | { ok: false; error: unknown }> = new Array(items.length);
	let next = 0;

	const runOne = async (): Promise<void> => {
		while (true) {
			const i = next++;
			if (i >= items.length) return;
			const item = items[i] as T;
			try {
				const value = await worker(item, i);
				results[i] = { ok: true, value };
			} catch (error) {
				results[i] = { ok: false, error };
			}
		}
	};

	const runners = Array.from({ length: Math.min(limit, items.length) }, () => runOne());
	await Promise.all(runners);
	return results;
}
