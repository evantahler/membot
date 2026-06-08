import { existsSync } from "node:fs";
import { join } from "node:path";
import { env, type FeatureExtractionPipeline, pipeline } from "@huggingface/transformers";
import {
	BGE_QUERY_PREFIX,
	BGE_QUERY_PREFIX_MODELS,
	CLS_POOLING_MODELS,
	EMBEDDING_BATCH_SIZE,
	EMBEDDING_DIMENSION,
	EMBEDDING_MODEL,
} from "../constants.ts";
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

const pipelinePromises = new Map<string, Promise<FeatureExtractionPipeline>>();

/**
 * Configure where transformers caches downloaded model weights.
 *
 * `MEMBOT_MODEL_CACHE_DIR`, when set, overrides `dir`. The test suite points
 * each test at a throwaway temp dir (to isolate the DB), which would force a
 * fresh model download from HuggingFace per CI run — and concurrent CI jobs
 * downloading the same weights trip HF's per-IP-range 429 limit. Model
 * weights are read-only and identical regardless of directory, so CI sets
 * this env var to one shared, `actions/cache`-restored dir; every test then
 * reuses the cached weights instead of re-fetching. Unset in normal use, so
 * local runs and the shipped binary keep the caller-provided dir.
 */
export function setEmbeddingCacheDir(dir: string): void {
	const override = process.env.MEMBOT_MODEL_CACHE_DIR?.trim();
	const resolved = override || dir;
	env.cacheDir = resolved.endsWith("/") ? resolved : `${resolved}/`;
}

function isModelCached(model: string): boolean {
	if (!env.cacheDir) return false;
	return existsSync(join(env.cacheDir, model));
}

/**
 * Lazily load (and cache) the feature-extraction pipeline for a model. Loading
 * is expensive (downloads weights on first run, ~100s of ms to instantiate
 * ONNX), so we hold one promise per model name for the life of the process.
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
async function getPipeline(model: string): Promise<FeatureExtractionPipeline> {
	let p = pipelinePromises.get(model);
	if (!p) {
		if (isModelCached(model)) {
			logger.debug(`embedder: loading cached model ${model}`);
		} else {
			logger.info(`embedder: loading model ${model} (first run, downloading weights)`);
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
		pipelinePromises.set(model, p);
	}
	return p;
}

/**
 * Options for `embed()`. `onProgress` fires once after each batch finishes
 * with `(done, total)` chunk counts so callers can drive a spinner / progress
 * bar — ONNX WASM holds the JS thread for hundreds of ms per batch and would
 * otherwise leave nanospinner's setInterval starved between updates.
 *
 * `directOnly` bypasses any registered EmbedderPool and runs the embed call
 * inline in the current process. Use it for query-time single-text embedding
 * where IPC overhead would dominate.
 *
 * `kind` selects asymmetric retrieval behavior. For BGE-v1.5 models, queries
 * get a recommended instruction prefix (`BGE_QUERY_PREFIX`) prepended before
 * embedding; passages stay un-prefixed. Default is `"passage"` so all bulk
 * ingest call sites keep their current behavior. Search-time callers pass
 * `"query"`. For non-BGE models the prefix is skipped.
 *
 * `pooling` overrides the per-model pooling mode (see `resolvePooling`).
 * This is an eval/test hook — it is honored only on the in-process path;
 * pool workers always derive pooling from the model name, which yields the
 * same answer for every production call site.
 */
export interface EmbedOptions {
	onProgress?: (done: number, total: number) => void;
	directOnly?: boolean;
	kind?: "query" | "passage";
	pooling?: "cls" | "mean";
}

/**
 * Pooling mode the model was trained with: CLS-token pooling for the BGE
 * family (per the upstream sentence-transformers config), mean pooling for
 * everything else. Using the wrong pooling silently degrades retrieval —
 * the vectors are still unit-length and "look" fine, they're just worse.
 */
export function resolvePooling(model: string): "cls" | "mean" {
	return CLS_POOLING_MODELS.has(model) ? "cls" : "mean";
}

/**
 * The minimal surface the embedder needs from a worker pool. Defined as an
 * interface (not an `import type`) so we don't take a hard dependency on
 * `embedder-pool.ts` from this hot path — the pool is plugged in via
 * `setEmbedderPool()` from outside.
 */
export interface PooledEmbedder {
	embed(texts: string[], model?: string, opts?: EmbedOptions): Promise<number[][]>;
}

let pool: PooledEmbedder | null = null;

/**
 * Register a worker pool to handle bulk embed calls. After this is set, every
 * `embed()` call (without `directOnly`) is dispatched through the pool.
 * Called once during `buildContext()` when `config.embedding.workers > 1`.
 */
export function setEmbedderPool(p: PooledEmbedder | null): void {
	pool = p;
}

/** Read the currently registered pool, or `null` when running single-process. */
export function getEmbedderPool(): PooledEmbedder | null {
	return pool;
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
	if (pool && !opts.directOnly) {
		return pool.embed(texts, model, opts);
	}
	const extractor = await getPipeline(model);
	const usePrefix = opts.kind === "query" && BGE_QUERY_PREFIX_MODELS.has(model);
	const inputs = usePrefix ? texts.map((t) => `${BGE_QUERY_PREFIX}${t}`) : texts;
	const pooling = opts.pooling ?? resolvePooling(model);
	const out: number[][] = [];
	for (let i = 0; i < inputs.length; i += EMBEDDING_BATCH_SIZE) {
		const slice = inputs.slice(i, i + EMBEDDING_BATCH_SIZE);
		const output = await extractor(slice, { pooling, normalize: true });
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

/**
 * Embed a single text — convenience wrapper for query-time embedding. Always
 * runs in-process (`directOnly: true`) so search latency isn't paying the IPC
 * round-trip through the worker pool for one vector.
 *
 * Pass `kind: "query"` to apply BGE-v1.5's asymmetric retrieval prefix to the
 * input before embedding. Default `"passage"` mirrors `embed()` so callers
 * that re-use `embedSingle` for non-search work (tests, ad-hoc scripts) get
 * vectors that line up with the bulk path.
 */
export async function embedSingle(
	text: string,
	model: string = EMBEDDING_MODEL,
	opts: { kind?: "query" | "passage"; pooling?: "cls" | "mean" } = {},
): Promise<number[]> {
	const all = await embed([text], model, { directOnly: true, kind: opts.kind ?? "passage", pooling: opts.pooling });
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
