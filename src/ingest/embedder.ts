import { existsSync } from "node:fs";
import { join } from "node:path";
import { env, type FeatureExtractionPipeline, pipeline } from "@huggingface/transformers";
import { EMBEDDING_BATCH_SIZE, EMBEDDING_DIMENSION, EMBEDDING_MODEL } from "../constants.ts";
import { HelpfulError } from "../errors.ts";
import { logger } from "../output/logger.ts";

// We patch @huggingface/transformers to use onnxruntime-web (WASM). Pin the
// loader to the on-disk copy so we stay offline-capable.
const ortWasm = env.backends.onnx?.wasm;
if (ortWasm) {
	ortWasm.wasmPaths = {
		mjs: import.meta.resolve("onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs"),
		wasm: import.meta.resolve("onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm"),
	};
}

// Pool keyed by `${model}#${slot}`. Each entry holds one fully-loaded pipeline;
// callers pass a `slot` (worker id) so concurrent ingest workers each get
// their own ONNX session and don't serialize on a shared extractor.
const pipelinePromises = new Map<string, Promise<FeatureExtractionPipeline>>();

function poolKey(model: string, slot: number): string {
	return `${model}#${slot}`;
}

/** Configure where transformers caches downloaded model weights. */
export function setEmbeddingCacheDir(dir: string): void {
	env.cacheDir = dir.endsWith("/") ? dir : `${dir}/`;
}

function isModelCached(model: string): boolean {
	if (!env.cacheDir) return false;
	return existsSync(join(env.cacheDir, model));
}

/**
 * Lazily load (and cache) one feature-extraction pipeline per (model, slot).
 * Loading is expensive (downloads weights on first run, ~100s of ms to
 * instantiate ONNX), so we hold one promise per pool key for the life of the
 * process. Bulk ingest passes a per-worker `slot` so each worker has its own
 * ONNX session — concurrent embed calls then run on independent extractors
 * instead of contending for one shared pipeline.
 *
 * Try `wasm` first, fall back to `cpu` on "Unsupported device". The transformers
 * patch (applied for `bun build --compile` and via `bun run prebuild` for local
 * dev) registers `wasm` as a supported device backed by onnxruntime-web — that's
 * mandatory for the single-binary build because native bindings can't be
 * bundled. When the package is unpatched (npm-installed membot, or `bun dev`
 * before `prebuild`), `wasm` is rejected and we fall back to the default `cpu`
 * device, which uses the onnxruntime-node native bindings that ship with the
 * unpatched package.
 */
async function getPipeline(model: string, slot: number): Promise<FeatureExtractionPipeline> {
	const key = poolKey(model, slot);
	let p = pipelinePromises.get(key);
	if (!p) {
		if (isModelCached(model)) {
			logger.debug(`embedder: loading cached model ${model} (slot ${slot})`);
		} else if (slot === 0) {
			logger.info(`embedder: loading model ${model} (first run, downloading weights)`);
		} else {
			logger.debug(`embedder: loading additional pipeline for slot ${slot}`);
		}
		p = (async () => {
			try {
				return (await pipeline("feature-extraction", model, { device: "wasm" })) as FeatureExtractionPipeline;
			} catch (err) {
				if (!String((err as Error)?.message ?? "").includes("Unsupported device")) throw err;
				logger.debug("embedder: wasm backend unavailable, falling back to cpu (onnxruntime-node)");
				return (await pipeline("feature-extraction", model, { device: "cpu" })) as FeatureExtractionPipeline;
			}
		})();
		pipelinePromises.set(key, p);
	}
	return p;
}

/**
 * Options for `embed()`. `onProgress` fires once after each batch finishes
 * with `(done, total)` chunk counts so callers can drive a spinner / progress
 * bar — ONNX WASM holds the JS thread for hundreds of ms per batch and would
 * otherwise leave nanospinner's setInterval starved between updates.
 *
 * `slot` selects which entry in the per-worker pipeline pool to use. Bulk
 * ingest passes the worker id so each ingest worker has its own extractor.
 * Callers that don't care (single-shot query embeds, refresh runner) omit
 * `slot` and share slot 0.
 */
export interface EmbedOptions {
	onProgress?: (done: number, total: number) => void;
	slot?: number;
}

/**
 * Embed an array of texts to L2-normalized vectors with the configured
 * model. Throws a HelpfulError when the model's dimension doesn't match
 * EMBEDDING_DIMENSION (the value baked into the DB schema).
 *
 * Inputs are sliced into windows of EMBEDDING_BATCH_SIZE so a single
 * forward pass never has to allocate activations for arbitrarily many
 * chunks — large files (hundreds of chunks) otherwise OOM the WASM heap.
 *
 * Between batches we yield a macrotask (`setTimeout(0)`) so the event loop
 * can flush nanospinner renders and stderr writes — without that, the spinner
 * visibly freezes for the entire embed phase on large files.
 */
export async function embed(
	texts: string[],
	model: string = EMBEDDING_MODEL,
	opts: EmbedOptions = {},
): Promise<number[][]> {
	if (texts.length === 0) return [];
	const extractor = await getPipeline(model, opts.slot ?? 0);
	const out: number[][] = [];
	for (let i = 0; i < texts.length; i += EMBEDDING_BATCH_SIZE) {
		const slice = texts.slice(i, i + EMBEDDING_BATCH_SIZE);
		const output = await extractor(slice, { pooling: "mean", normalize: true });
		const data = output.tolist() as number[][];
		if (out.length === 0 && data[0] && data[0].length !== EMBEDDING_DIMENSION) {
			throw new HelpfulError({
				kind: "internal_error",
				message: `embedding model ${model} returned ${data[0].length}-dim vectors, expected ${EMBEDDING_DIMENSION}`,
				hint: `Set config.embedding_model to a ${EMBEDDING_DIMENSION}-dim model (default: ${EMBEDDING_MODEL}).`,
			});
		}
		for (const vec of data) out.push(vec);
		opts.onProgress?.(out.length, texts.length);
		// Yield a macrotask so nanospinner's setInterval and any queued
		// stderr writes get a chance to run between batches.
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
	return out;
}

/** Embed a single text — convenience wrapper for query-time embedding. */
export async function embedSingle(text: string, model: string = EMBEDDING_MODEL): Promise<number[]> {
	const all = await embed([text], model);
	const vec = all[0];
	if (!vec) {
		throw new HelpfulError({
			kind: "internal_error",
			message: "embed() returned no vectors",
			hint: "This is likely a transformers WASM patch issue. Run `bun run prebuild` and retry.",
		});
	}
	return vec;
}
