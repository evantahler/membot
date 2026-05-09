import { env } from "@huggingface/transformers";
import { HelpfulError } from "../errors.ts";
import { logger } from "../output/logger.ts";

interface PendingJob {
	resolve: (embeddings: number[][]) => void;
	reject: (err: Error) => void;
	onProgress?: (done: number, total: number) => void;
}

interface QueuedJob {
	texts: string[];
	model: string;
	pending: PendingJob;
}

/**
 * Pool of Bun Workers, each hosting an independent transformers
 * feature-extraction pipeline. `embed()` dispatches each call to an idle
 * worker; queued calls run as workers finish. This is what makes ingest
 * truly parallel on the embed step — each worker is its own OS thread with
 * its own ONNX session, so N embed() calls run on N cores rather than
 * serializing on the main JS event loop.
 *
 * Lifecycle: `await pool.init()` once after construction (sends a one-time
 * init message to each worker so the test cacheDir is forwarded), use
 * `embed()` per job, then `await pool.shutdown()` to terminate the workers.
 * Failure to call `shutdown()` leaks threads.
 */
export class EmbedPool {
	private readonly workers: Worker[] = [];
	private readonly busy: boolean[] = [];
	private readonly queue: QueuedJob[] = [];
	private readonly pendingByJobId = new Map<number, { workerIdx: number; pending: PendingJob }>();
	private nextJobId = 0;
	private initialized = false;
	private shutdownStarted = false;

	constructor(workerCount: number) {
		const n = Math.max(1, Math.floor(workerCount));
		for (let i = 0; i < n; i++) {
			const worker = new Worker(new URL("./embed-worker.ts", import.meta.url).href, {
				type: "module",
			});
			worker.onmessage = (ev: MessageEvent) => this.onMessage(i, ev);
			worker.onerror = (ev: ErrorEvent) => this.onWorkerError(i, ev);
			this.workers.push(worker);
			this.busy.push(false);
		}
	}

	get size(): number {
		return this.workers.length;
	}

	/** One-time init: forward the transformers cacheDir to every worker. */
	async init(): Promise<void> {
		if (this.initialized) return;
		const cacheDir = typeof env.cacheDir === "string" ? env.cacheDir : undefined;
		await Promise.all(
			this.workers.map(
				(w) =>
					new Promise<void>((resolve, reject) => {
						const onMessage = (ev: MessageEvent) => {
							if (ev.data?.type === "init-ok") {
								w.removeEventListener("message", onMessage as EventListener);
								resolve();
							}
						};
						const onError = (ev: ErrorEvent) => {
							w.removeEventListener("error", onError as EventListener);
							reject(new Error(ev.message ?? "embed worker init failed"));
						};
						w.addEventListener("message", onMessage as EventListener);
						w.addEventListener("error", onError as EventListener);
						w.postMessage({ type: "init", cacheDir });
					}),
			),
		);
		this.initialized = true;
	}

	/**
	 * Enqueue one embed job. Returns the embeddings when whichever worker
	 * picks it up has finished. Throws via `HelpfulError` on worker failure
	 * so the caller's normal error-handling path sees a typed error.
	 */
	embed(texts: string[], model: string, onProgress?: (done: number, total: number) => void): Promise<number[][]> {
		if (this.shutdownStarted) {
			return Promise.reject(new Error("embed pool has been shut down"));
		}
		return new Promise<number[][]>((resolve, reject) => {
			const pending: PendingJob = { resolve, reject, onProgress };
			const idx = this.busy.indexOf(false);
			if (idx >= 0) {
				this.busy[idx] = true;
				this.dispatch(idx, texts, model, pending);
			} else {
				this.queue.push({ texts, model, pending });
			}
		});
	}

	/** Terminate every worker. Pending jobs reject with a "shut down" error. */
	async shutdown(): Promise<void> {
		this.shutdownStarted = true;
		for (const [id, entry] of this.pendingByJobId) {
			entry.pending.reject(new Error(`embed pool shut down with job ${id} pending`));
		}
		this.pendingByJobId.clear();
		for (const job of this.queue) {
			job.pending.reject(new Error("embed pool shut down before job started"));
		}
		this.queue.length = 0;
		for (const w of this.workers) {
			w.terminate();
		}
		this.workers.length = 0;
		this.busy.length = 0;
	}

	private dispatch(workerIdx: number, texts: string[], model: string, pending: PendingJob): void {
		const id = this.nextJobId++;
		this.pendingByJobId.set(id, { workerIdx, pending });
		const worker = this.workers[workerIdx];
		if (!worker) {
			pending.reject(new Error(`embed worker ${workerIdx} is not available`));
			return;
		}
		worker.postMessage({ type: "embed", id, texts, model });
	}

	private onMessage(workerIdx: number, ev: MessageEvent): void {
		const data = ev.data as
			| { type: "progress"; id: number; done: number; total: number }
			| { type: "result"; id: number; embeddings: number[][] }
			| { type: "error"; id: number; message: string }
			| { type: "init-ok" };
		if (data.type === "init-ok") return;
		const entry = this.pendingByJobId.get(data.id);
		if (!entry) return;
		if (data.type === "progress") {
			entry.pending.onProgress?.(data.done, data.total);
			return;
		}
		this.pendingByJobId.delete(data.id);
		this.busy[workerIdx] = false;
		if (data.type === "result") {
			entry.pending.resolve(data.embeddings);
		} else {
			entry.pending.reject(
				new HelpfulError({
					kind: "internal_error",
					message: `embed worker ${workerIdx} failed: ${data.message}`,
					hint: "Run `bun run prebuild` to apply the transformers WASM patch, or set a different config.embedding_model.",
				}),
			);
		}
		const next = this.queue.shift();
		if (next) {
			this.busy[workerIdx] = true;
			this.dispatch(workerIdx, next.texts, next.model, next.pending);
		}
	}

	private onWorkerError(workerIdx: number, ev: ErrorEvent): void {
		logger.warn(`embed worker ${workerIdx} crashed: ${ev.message}`);
		// Reject every job currently pending against this specific worker.
		for (const [id, entry] of this.pendingByJobId) {
			if (entry.workerIdx !== workerIdx) continue;
			this.pendingByJobId.delete(id);
			entry.pending.reject(new Error(`embed worker ${workerIdx} crashed: ${ev.message}`));
		}
		this.busy[workerIdx] = false;
	}
}
