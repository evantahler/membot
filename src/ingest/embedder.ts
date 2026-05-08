import { existsSync } from "node:fs";
import { join } from "node:path";
import { env, type FeatureExtractionPipeline, pipeline } from "@huggingface/transformers";
import { EMBEDDING_DIMENSION, EMBEDDING_MODEL } from "../constants.ts";
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

/** Configure where transformers caches downloaded model weights. */
export function setEmbeddingCacheDir(dir: string): void {
	env.cacheDir = dir.endsWith("/") ? dir : `${dir}/`;
}

function isModelCached(model: string): boolean {
	if (!env.cacheDir) return false;
	return existsSync(join(env.cacheDir, model));
}

/**
 * Lazily load (and cache) the feature-extraction pipeline for a model. Loading
 * is expensive (downloads weights on first run, ~100s of ms to instantiate
 * ONNX), so we hold one promise per model name for the life of the process.
 */
async function getPipeline(model: string): Promise<FeatureExtractionPipeline> {
	let p = pipelinePromises.get(model);
	if (!p) {
		if (isModelCached(model)) {
			logger.debug(`embedder: loading cached model ${model}`);
		} else {
			logger.info(`embedder: loading model ${model} (first run, downloading weights)`);
		}
		// device: "wasm" matches what our transformers patch supports — the
		// default ("cpu") errors out because the patch removes onnxruntime-node.
		p = pipeline("feature-extraction", model, { device: "wasm" }) as Promise<FeatureExtractionPipeline>;
		pipelinePromises.set(model, p);
	}
	return p;
}

/**
 * Embed an array of texts to L2-normalized vectors with the configured
 * model. Throws a HelpfulError when the model's dimension doesn't match
 * EMBEDDING_DIMENSION (the value baked into the DB schema).
 */
export async function embed(texts: string[], model: string = EMBEDDING_MODEL): Promise<number[][]> {
	if (texts.length === 0) return [];
	const extractor = await getPipeline(model);
	const output = await extractor(texts, { pooling: "mean", normalize: true });
	const data = output.tolist() as number[][];
	if (data[0] && data[0].length !== EMBEDDING_DIMENSION) {
		throw new HelpfulError({
			kind: "internal_error",
			message: `embedding model ${model} returned ${data[0].length}-dim vectors, expected ${EMBEDDING_DIMENSION}`,
			hint: `Set config.embedding_model to a ${EMBEDDING_DIMENSION}-dim model (default: ${EMBEDDING_MODEL}).`,
		});
	}
	return data;
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
