import { AutoModelForSequenceClassification, AutoTokenizer } from "@huggingface/transformers";
import { RERANK_BATCH_SIZE, RERANK_MODEL } from "../constants.ts";
import { asHelpful } from "../errors.ts";
import { isModelCached } from "../ingest/embedder.ts";
import { logger } from "../output/logger.ts";
import { createModelDownloadReporter } from "../output/model-download.ts";

/**
 * The slice of the transformers sequence-classification surface we actually
 * use. `@huggingface/transformers` types these loosely; we cast once at the
 * load boundary and keep everything downstream typed.
 */
type RerankTokenizer = (
	queries: string[],
	opts: { text_pair: string[]; padding: boolean; truncation: boolean },
) => Record<string, unknown>;

type RerankModel = (inputs: Record<string, unknown>) => Promise<{ logits: { tolist(): number[][] } }>;

interface LoadedReranker {
	tokenizer: RerankTokenizer;
	model: RerankModel;
}

const rerankerPromises = new Map<string, Promise<LoadedReranker>>();

/**
 * Lazily load (and cache for the life of the process) the cross-encoder
 * tokenizer + model. Mirrors the embedder's device strategy: `wasm` first
 * (the patched onnxruntime-web backend used by the compiled binary), falling
 * back to `cpu` (onnxruntime-node) when the package is unpatched.
 */
async function getReranker(model: string): Promise<LoadedReranker> {
	let p = rerankerPromises.get(model);
	if (!p) {
		logger.debug(`reranker: loading model ${model}`);
		// One reporter spans the tokenizer + model file downloads so a single
		// bar covers the whole reranker fetch. Attached only on a genuine
		// first-run fetch (not on disk) — transformers fires a `download` status
		// even for cache reads, so the disk check is the reliable signal. Rerank
		// always runs in the parent process so the bar renders cleanly.
		const reporter = isModelCached(model) ? null : createModelDownloadReporter("reranker", model);
		const progress_callback = reporter?.onProgress;
		p = (async () => {
			try {
				const tokenizer = (await AutoTokenizer.from_pretrained(model, {
					progress_callback,
				})) as unknown as RerankTokenizer;
				let seqModel: RerankModel;
				try {
					seqModel = (await AutoModelForSequenceClassification.from_pretrained(model, {
						device: "wasm",
						progress_callback,
					})) as unknown as RerankModel;
				} catch (err) {
					if (!String((err as Error)?.message ?? "").includes("Unsupported device")) throw err;
					logger.debug("reranker: wasm backend unavailable, falling back to cpu (onnxruntime-node)");
					seqModel = (await AutoModelForSequenceClassification.from_pretrained(model, {
						device: "cpu",
						progress_callback,
					})) as unknown as RerankModel;
				}
				return { tokenizer, model: seqModel };
			} finally {
				reporter?.finish();
			}
		})();
		rerankerPromises.set(model, p);
	}
	return p;
}

/**
 * Score `texts` against `query` with a local cross-encoder and return one
 * relevance score per text, in input order. Scores are sigmoid(logit) ∈
 * (0, 1) — comparable within one call, not across models. Pairs are scored
 * in batches of `RERANK_BATCH_SIZE` to bound WASM activations, same
 * rationale as the embedder's batching. The tokenizer truncates each pair
 * to the model's window (512 tokens for the MS-MARCO MiniLM default), which
 * is exactly the regime cross-encoders are trained for.
 */
export async function rerankScores(query: string, texts: string[], model: string = RERANK_MODEL): Promise<number[]> {
	if (texts.length === 0) return [];
	try {
		const { tokenizer, model: seqModel } = await getReranker(model);
		const out: number[] = [];
		for (let i = 0; i < texts.length; i += RERANK_BATCH_SIZE) {
			const slice = texts.slice(i, i + RERANK_BATCH_SIZE);
			const inputs = tokenizer(new Array<string>(slice.length).fill(query), {
				text_pair: slice,
				padding: true,
				truncation: true,
			});
			const { logits } = await seqModel(inputs);
			for (const row of logits.tolist()) {
				const logit = row[0] ?? 0;
				out.push(1 / (1 + Math.exp(-logit)));
			}
			// Yield a macrotask between batches so spinner renders and stderr
			// writes aren't starved by the WASM forward pass.
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
		}
		return out;
	} catch (err) {
		throw asHelpful(
			err,
			`while reranking with ${model}`,
			"Retry without --rerank (or `membot config set search.rerank false`); if the model failed to download, check network access or set search.rerank_model to a different cross-encoder.",
			"internal_error",
		);
	}
}
