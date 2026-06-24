import { env } from "@huggingface/transformers";
import type { Subprocess } from "bun";
import { EMBED_WORKER_SENTINEL, EMBEDDING_BATCH_SIZE, EMBEDDING_MODEL } from "../constants.ts";
import { asHelpful, HelpfulError } from "../errors.ts";
import { logger } from "../output/logger.ts";
import { type EmbedOptions, ensureEmbeddingModelDownloaded, setEmbedderPool } from "./embedder.ts";

interface PendingRequest {
	id: number;
	resolve: (vectors: number[][]) => void;
	reject: (err: unknown) => void;
}

interface Worker {
	proc: Subprocess<"pipe", "pipe", "inherit">;
	busy: boolean;
	pending: PendingRequest | null;
	exited: boolean;
}

interface EmbedResponseLine {
	type: "embed-response";
	id: number;
	vectors?: number[][];
	error?: { kind: string; message: string; hint: string };
}

/**
 * A short-lived pool of embed-worker subprocesses. Created at the start of
 * a bulk-embedding command (`add` / `refresh` / `write`), kept alive only
 * for the duration of that command, and disposed before the command
 * returns. Workers spawn lazily — they don't pre-load the WASM pipeline;
 * the model is loaded on-demand inside the worker the first time a batch
 * arrives. Each worker holds its own ~50MB WASM heap, so the parallelism
 * comes for free in CPU but costs proportional RAM while the command runs.
 *
 * The pool is plugged in via `setEmbedderPool()` so the existing `embed()`
 * call sites in the ingest pipeline transparently fan out without code
 * changes.
 */
export class EmbedderPool {
	private readonly workerCount: number;
	private readonly model: string;
	private workers: Worker[] = [];
	private acquireQueue: Array<(w: Worker) => void> = [];
	private nextRequestId = 1;
	private spawned = false;
	private disposed = false;

	constructor(workerCount: number, model: string = EMBEDDING_MODEL) {
		if (workerCount < 1 || !Number.isInteger(workerCount)) {
			throw new HelpfulError({
				kind: "input_error",
				message: `EmbedderPool worker count must be a positive integer, got ${workerCount}`,
				hint: "Set config.embedding.workers to a positive integer (or null for auto = cpus-1).",
			});
		}
		this.workerCount = workerCount;
		this.model = model;
	}

	/** Number of worker subprocesses this pool manages. */
	get size(): number {
		return this.workerCount;
	}

	/**
	 * Spawn the worker subprocesses. Returns immediately — workers load the
	 * WASM model lazily when the first batch arrives, so this is a cheap
	 * operation. The first batch a worker receives pays the ~hundreds-of-ms
	 * load cost; subsequent batches in the same worker are fast.
	 */
	spawn(): void {
		if (this.spawned) return;
		this.spawned = true;
		logger.info(`embedder-pool: spawning ${this.workerCount} workers (model=${this.model})`);
		for (let i = 0; i < this.workerCount; i++) {
			this.workers.push(this.spawnWorker(i));
		}
	}

	/**
	 * Send one tiny embed to each worker so they each pay the WASM model-load
	 * cost up front instead of stalling the first real batch. Relies on
	 * `acquire()` synchronously handing out distinct workers when N concurrent
	 * dispatches race against N idle workers, so every worker receives exactly
	 * one warmup. No-op when not yet spawned or when disposed.
	 *
	 * The first batch is awaited serially so that on a cold model cache only
	 * one worker downloads the weights. `@huggingface/transformers` has no
	 * inter-process coordination — a fan-out warmup against an empty cache
	 * triggers N concurrent downloads and N writers into the same cache files,
	 * which both wastes bandwidth and risks corruption. Once the first worker
	 * finishes loading, the cache is populated; the remaining workers fan out
	 * in parallel and hit the cache.
	 */
	async warmup(): Promise<void> {
		if (this.disposed || !this.spawned) return;
		logger.info(`embedder-pool: warming up ${this.workers.length} workers`);
		await this.dispatchBatch(["warmup"], this.model);
		if (this.workers.length <= 1 || this.disposed) return;
		await Promise.all(
			Array.from({ length: this.workers.length - 1 }, () => this.dispatchBatch(["warmup"], this.model)),
		);
	}

	/**
	 * Embed `texts` using the worker pool. Splits into batches of
	 * `EMBEDDING_BATCH_SIZE`, dispatches each batch to whichever worker is
	 * free, and reassembles vectors in original order. `opts.onProgress` is
	 * called once per completed batch with `(done, total)` chunk counts.
	 */
	async embed(texts: string[], model?: string, opts: EmbedOptions = {}): Promise<number[][]> {
		if (this.disposed) {
			throw new HelpfulError({
				kind: "internal_error",
				message: "EmbedderPool: embed() called after dispose()",
				hint: "The pool is per-command — wrap your work in `withEmbedderPool()` so a fresh pool is created.",
			});
		}
		if (!this.spawned) this.spawn();
		if (texts.length === 0) return [];

		const targetModel = model ?? this.model;
		const out = new Array<number[]>(texts.length);
		let done = 0;

		const batches: Array<{ start: number; texts: string[] }> = [];
		for (let i = 0; i < texts.length; i += EMBEDDING_BATCH_SIZE) {
			batches.push({ start: i, texts: texts.slice(i, i + EMBEDDING_BATCH_SIZE) });
		}

		await Promise.all(
			batches.map(async (batch) => {
				const vectors = await this.dispatchBatch(batch.texts, targetModel);
				for (let i = 0; i < vectors.length; i++) {
					const vec = vectors[i];
					if (!vec) {
						throw new HelpfulError({
							kind: "internal_error",
							message: `embedder-pool: worker returned undefined vector at batch index ${i}`,
							hint: "Re-run with --verbose; check the worker stderr for a transformers/WASM error.",
						});
					}
					out[batch.start + i] = vec;
				}
				done += vectors.length;
				opts.onProgress?.(done, texts.length);
			}),
		);
		return out;
	}

	/**
	 * Tear down every worker subprocess. Idempotent. Pending requests are
	 * rejected so any in-flight `embed()` callers see a HelpfulError instead
	 * of hanging forever.
	 */
	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		if (this.spawned) {
			logger.info(`embedder-pool: tearing down ${this.workers.length} workers`);
		}
		const disposeError = () =>
			new HelpfulError({
				kind: "internal_error",
				message: "EmbedderPool disposed while a request was in flight",
				hint: "This is usually fine on shutdown; if it appears mid-run, file an issue with the preceding stderr.",
			});
		for (const w of this.workers) {
			if (w.pending) {
				w.pending.reject(disposeError());
				w.pending = null;
			}
			try {
				w.proc.stdin.end();
			} catch {
				// stdin may already be closed; ignore.
			}
			try {
				w.proc.kill();
			} catch {
				// process may already be dead; ignore.
			}
		}
		// Anyone waiting on acquire() will never get a worker — release them.
		const queue = this.acquireQueue;
		this.acquireQueue = [];
		for (const resolver of queue) {
			// Fabricate an "already exited" worker so dispatchBatch's disposed
			// guard fires and rejects with a clear error.
			resolver({
				proc: null as unknown as Subprocess<"pipe", "pipe", "inherit">,
				busy: true,
				pending: null,
				exited: true,
			});
		}
		await Promise.all(
			this.workers.map(async (w) => {
				try {
					await w.proc.exited;
				} catch {
					// best effort
				}
			}),
		);
		this.workers = [];
	}

	/** Send one batch to a free worker and resolve with its vectors. */
	private async dispatchBatch(texts: string[], model: string): Promise<number[][]> {
		const worker = await this.acquire();
		try {
			if (this.disposed || worker.exited) {
				throw new HelpfulError({
					kind: "internal_error",
					message: "EmbedderPool disposed before batch could be dispatched",
					hint: "The pool was torn down mid-call — wrap your work in `withEmbedderPool()` for a fresh per-command pool.",
				});
			}
			const id = this.nextRequestId++;
			return await new Promise<number[][]>((resolve, reject) => {
				worker.pending = { id, resolve, reject };
				try {
					worker.proc.stdin.write(`${JSON.stringify({ type: "embed", id, model, texts })}\n`);
					worker.proc.stdin.flush();
				} catch (err) {
					worker.pending = null;
					reject(
						asHelpful(
							err,
							"while writing to embed worker stdin",
							"The worker subprocess likely crashed. Set config.embedding.workers=1 to bypass the pool while debugging.",
						),
					);
				}
			});
		} finally {
			this.release(worker);
		}
	}

	/** Wait for a free worker; first-come, first-served via the acquireQueue. */
	private acquire(): Promise<Worker> {
		const free = this.workers.find((w) => !w.exited && !w.busy);
		if (free) {
			free.busy = true;
			return Promise.resolve(free);
		}
		return new Promise((resolve) => {
			this.acquireQueue.push((w) => {
				w.busy = true;
				resolve(w);
			});
		});
	}

	/**
	 * Hand a finished worker to the next waiter, or mark it idle. Called from
	 * `dispatchBatch`'s finally block so it runs whether the request resolved
	 * or rejected.
	 */
	private release(w: Worker): void {
		w.pending = null;
		w.busy = false;
		if (w.exited) return;
		const next = this.acquireQueue.shift();
		if (next) next(w);
	}

	/**
	 * Build the spawn command for one worker. Two regimes:
	 *  - Compiled binary (`./dist/membot`): `process.execPath` is the membot
	 *    binary itself, so we just hand it the sentinel arg and the early
	 *    branch in `cli.ts` takes over before commander sees it.
	 *  - Bun dev / `bun add -g`: `process.execPath` is the `bun` binary; we
	 *    must point it at `cli.ts` explicitly. Resolve the path relative to
	 *    this module so it survives whatever working directory the user
	 *    invoked membot from.
	 */
	private resolveSpawnCommand(): string[] {
		const exec = process.execPath;
		const isBun = /[\\/]bunx?(\.exe)?$/.test(exec);
		if (!isBun) {
			return [exec, EMBED_WORKER_SENTINEL];
		}
		const cliPath = new URL("../cli.ts", import.meta.url).pathname;
		return [exec, cliPath, EMBED_WORKER_SENTINEL];
	}

	/**
	 * Spawn one worker subprocess and start its stdout reader. The worker
	 * lazy-loads the WASM pipeline on its first `embed` request, so spawn is
	 * cheap (no init handshake, no preload).
	 */
	private spawnWorker(index: number): Worker {
		// Pin the worker's model cache to the parent's resolved dir so both
		// processes read/write the same weights — without this a worker could
		// fall back to transformers' default cache and re-download. `setEmbeddingCacheDir`
		// (called in the worker bootstrap) honors this env var.
		const workerEnv = { ...process.env, ...(env.cacheDir ? { MEMBOT_MODEL_CACHE_DIR: env.cacheDir } : {}) };
		const proc = Bun.spawn(this.resolveSpawnCommand(), {
			stdio: ["pipe", "pipe", "inherit"],
			env: workerEnv,
		}) as Subprocess<"pipe", "pipe", "inherit">;

		const worker: Worker = {
			proc,
			busy: false,
			pending: null,
			exited: false,
		};

		// Watch for premature exit and surface it to any in-flight request.
		void proc.exited
			.then((code) => {
				worker.exited = true;
				if (worker.pending) {
					worker.pending.reject(
						new HelpfulError({
							kind: "internal_error",
							message: `embed worker ${index} exited (code=${code}) with a request in flight`,
							hint: "Run with --verbose; the worker's stderr was inherited and should explain the crash.",
						}),
					);
					worker.pending = null;
				}
			})
			.catch(() => {
				// Bun's exited promise shouldn't reject, but guard anyway.
			});

		void this.readWorker(worker, index);
		return worker;
	}

	/**
	 * Newline-delimited JSON reader for one worker's stdout. Matches every
	 * `{type:"embed-response", id}` to its pending request.
	 */
	private async readWorker(worker: Worker, index: number): Promise<void> {
		const reader = worker.proc.stdout.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				while (true) {
					const nl = buffer.indexOf("\n");
					if (nl === -1) break;
					const line = buffer.slice(0, nl);
					buffer = buffer.slice(nl + 1);
					if (!line.trim()) continue;
					this.handleWorkerLine(worker, index, line);
				}
			}
		} catch (err) {
			logger.debug(`embedder-pool: worker ${index} stdout read failed: ${(err as Error).message}`);
		}
	}

	/** Parse + dispatch one JSON line emitted by a worker. */
	private handleWorkerLine(worker: Worker, index: number, line: string): void {
		let parsed: EmbedResponseLine;
		try {
			parsed = JSON.parse(line) as EmbedResponseLine;
		} catch {
			logger.debug(`embedder-pool: worker ${index} emitted unparseable line: ${line.slice(0, 200)}`);
			return;
		}
		if (parsed.type !== "embed-response") return;
		const pending = worker.pending;
		if (!pending) {
			logger.debug(`embedder-pool: worker ${index} returned response with no pending request`);
			return;
		}
		if (parsed.error) {
			pending.reject(
				new HelpfulError({
					kind: "internal_error",
					message: `embed worker ${index} failed: ${parsed.error.message}`,
					hint: parsed.error.hint || "Inspect parent stderr for the full error.",
				}),
			);
		} else if (parsed.vectors) {
			pending.resolve(parsed.vectors);
		} else {
			pending.reject(
				new HelpfulError({
					kind: "internal_error",
					message: `embed worker ${index} returned response with neither vectors nor error`,
					hint: "This is a worker protocol bug — file an issue with the preceding stderr.",
				}),
			);
		}
	}
}

/**
 * Run `fn` with a fresh `EmbedderPool` registered as the global embedder. The
 * pool is created, plugged in via `setEmbedderPool()`, and disposed
 * (subprocesses killed) before `fn`'s promise resolves — so the workers only
 * exist for the duration of one bulk-embedding command (`add` / `refresh` /
 * `write` / a daemon tick). When `workers <= 1` the helper short-circuits
 * and runs `fn` inline against the single-process embedder, with no spawn
 * overhead.
 */
export async function withEmbedderPool<T>(workerCount: number, model: string, fn: () => Promise<T>): Promise<T> {
	// Surface a first-run download bar in the parent (where the UI lives) before
	// any embedding starts. On the worker-pool path this also warms the on-disk
	// cache so the workers don't each silently download inside a subprocess.
	await ensureEmbeddingModelDownloaded(model, { keepLoaded: workerCount <= 1 });
	if (workerCount <= 1) return fn();
	const pool = new EmbedderPool(workerCount, model);
	pool.spawn();
	await pool.warmup();
	setEmbedderPool(pool);
	try {
		return await fn();
	} finally {
		setEmbedderPool(null);
		await pool.dispose();
	}
}
