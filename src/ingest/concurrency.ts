/**
 * Run `worker(item, index, workerId)` over `items` with at most `concurrency`
 * workers in flight at a time. Each runner has a stable `workerId` in
 * `[0, concurrency)` for the life of the call — useful when callers want to
 * address per-worker UI slots. Results come back in input order. Worker
 * rejections are caught and surfaced as `{ ok: false, error }` entries
 * instead of aborting the batch; partial failures are normal during bulk
 * ingest, and the caller decides how to render them per-entry.
 */
export async function pMap<T, R>(
	items: readonly T[],
	concurrency: number,
	worker: (item: T, index: number, workerId: number) => Promise<R>,
): Promise<Array<{ ok: true; value: R } | { ok: false; error: unknown }>> {
	const limit = Math.max(1, Math.floor(concurrency));
	const results: Array<{ ok: true; value: R } | { ok: false; error: unknown }> = new Array(items.length);
	let next = 0;

	const runOne = async (workerId: number): Promise<void> => {
		while (true) {
			const i = next++;
			if (i >= items.length) return;
			const item = items[i] as T;
			try {
				const value = await worker(item, i, workerId);
				results[i] = { ok: true, value };
			} catch (error) {
				results[i] = { ok: false, error };
			}
		}
	};

	const runners = Array.from({ length: Math.min(limit, items.length) }, (_, workerId) => runOne(workerId));
	await Promise.all(runners);
	return results;
}

/**
 * Single-slot async mutex. `lock(fn)` runs `fn` with exclusive access and
 * returns its result; queued callers run in FIFO order. Used to gate the
 * persist phase of bulk ingest because all workers share a single DuckDB
 * connection and DuckDB rejects nested `BEGIN` statements.
 */
export class AsyncMutex {
	private chain: Promise<void> = Promise.resolve();

	async lock<T>(fn: () => Promise<T>): Promise<T> {
		const prev = this.chain;
		let release!: () => void;
		this.chain = new Promise<void>((r) => {
			release = r;
		});
		await prev;
		try {
			return await fn();
		} finally {
			release();
		}
	}
}
