import { homedir } from "node:os";
import { join } from "node:path";

/** Default data directory: `~/.membot`. Override via $MEMBOT_HOME or `--config`. */
export function defaultMembotHome(): string {
	const env = process.env.MEMBOT_HOME;
	if (env?.trim()) return env;
	return join(homedir(), ".membot");
}

export const ENV = {
	HOME: "MEMBOT_HOME",
	CONFIG: "MEMBOT_CONFIG",
	DEBUG: "MEMBOT_DEBUG",
	ANTHROPIC_API_KEY: "ANTHROPIC_API_KEY",
	NO_UPDATE_CHECK: "MEMBOT_NO_UPDATE_CHECK",
} as const;

export const EMBEDDING_MODEL = "Xenova/bge-small-en-v1.5";
export const EMBEDDING_DIMENSION = 384;

/**
 * BGE-v1.5 retrieval is asymmetric: query embeddings improve when prefixed
 * with this instruction, while passage embeddings stay un-prefixed. Applied
 * at query time only (in `embedSingle`), so stored DB embeddings are
 * unaffected and no reindex is needed when toggling this on.
 *
 * Source: BGE-v1.5 model card on HuggingFace.
 */
export const BGE_QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";

/**
 * Models in the BGE-v1.5 family that benefit from `BGE_QUERY_PREFIX`. Other
 * models (future embedder swap-ins) get the raw query text — adding an
 * instruction prefix to a non-instruction-tuned model degrades retrieval.
 */
export const BGE_QUERY_PREFIX_MODELS: ReadonlySet<string> = new Set([
	"Xenova/bge-small-en-v1.5",
	"Xenova/bge-base-en-v1.5",
	"Xenova/bge-large-en-v1.5",
]);

/**
 * Models trained with CLS-token pooling. BGE-v1.5's sentence-transformers
 * config sets `pooling_mode_cls_token: true` — the model card explicitly
 * says to take the last hidden state of `[CLS]` as the sentence embedding.
 * Mean pooling on these models produces measurably worse retrieval vectors.
 * Models not in this set get mean pooling (the safe default for most
 * sentence-transformers checkpoints).
 */
export const CLS_POOLING_MODELS: ReadonlySet<string> = new Set([
	"Xenova/bge-small-en-v1.5",
	"Xenova/bge-base-en-v1.5",
	"Xenova/bge-large-en-v1.5",
]);

/**
 * Revision of the embedding scheme (pooling mode + chunk sizing + search_text
 * shape). Bump this whenever stored vectors become incomparable with vectors
 * the current code produces, and add a line to the history below. Stored per
 * DB in `meta.embedding_revision`; a mismatch at search time warns the user
 * to run `membot reindex --embeddings`.
 *
 * History:
 *   1 — mean pooling, 4000/15000-char chunks, search_text = path\ndesc\n\nbody
 *   2 — CLS pooling for BGE, 1400/1800-char chunks sized to bge-small's
 *       512-token window, heading breadcrumb line in search_text, description
 *       capped at 240 chars in search_text
 */
export const EMBEDDING_REVISION = 2;

/**
 * Default cross-encoder used by `membot search --rerank`. A ~23M-param
 * MS-MARCO-tuned MiniLM — small enough that reranking ~30 candidates on the
 * WASM backend stays in the hundreds-of-ms range, while still providing the
 * usual cross-encoder precision lift over bi-encoder cosine scores.
 * Override via `config.search.rerank_model`.
 */
export const RERANK_MODEL = "Xenova/ms-marco-MiniLM-L-6-v2";

/** Candidate pairs scored per forward pass in the reranker (memory bound, same rationale as EMBEDDING_BATCH_SIZE). */
export const RERANK_BATCH_SIZE = 8;

/**
 * Max chunks fed to the feature-extraction pipeline in one forward pass.
 * ONNX/WASM allocates activations linearly with batch size, so a single
 * unbounded call OOMs (`std::bad_alloc`) on large files — a 168-chunk file
 * was the original repro. 16 is comfortably within the WASM heap for
 * bge-small-en-v1.5 at 512 tokens and still amortizes the per-call overhead.
 */
export const EMBEDDING_BATCH_SIZE = 16;

/**
 * Hidden first-arg sentinel that re-execs the membot binary as an embed
 * worker. The pool spawns `process.execPath <sentinel>` so the same compiled
 * binary serves both the user-facing CLI and the worker subprocess; cli.ts
 * checks this argv slot before commander sees it.
 */
export const EMBED_WORKER_SENTINEL = "__embed_worker";

export const DEFAULTS = {
	CHUNKER_MODE: "deterministic" as const,
	/**
	 * Chunk sizes are budgeted against the embedding model's input window, NOT
	 * against what fits comfortably in a search snippet. bge-small-en-v1.5
	 * truncates at 512 tokens (~1,800-2,000 chars of English prose), and the
	 * embedded string is `search_text` — path + description (+ heading
	 * breadcrumb) PREPENDED to the chunk body, which costs another ~250-300
	 * chars. A 1,400-char body keeps typical search_text inside the window;
	 * anything larger silently embeds only a prefix of the chunk (the original
	 * 4,000/15,000 defaults left over half of every chunk invisible to vector
	 * search). MAX is a hard cap applied after overlap; slight truncation on
	 * pathological single-line content is accepted.
	 */
	CHUNKER_TARGET_CHARS: 1_400,
	CHUNKER_MAX_CHARS: 1_800,
	DAEMON_TICK_SEC: 60,
	HTTP_TIMEOUT_MS: 30_000,
	CONVERTER_MODEL: "claude-haiku-4-5-20251001",
	CHUNKER_MODEL: "claude-haiku-4-5-20251001",
	DESCRIBER_MODEL: "claude-haiku-4-5-20251001",
	VISION_MODEL: "claude-haiku-4-5-20251001",
	UPDATE_CHECK_INTERVAL_MS: 24 * 60 * 60 * 1000,
	UPDATE_CHECK_TIMEOUT_MS: 5_000,
	/**
	 * Per-document cap on Claude vision caption calls when expanding inline
	 * images during DOCX/HTML conversion. Beyond this, images get a small
	 * deterministic placeholder so a slide-deck-shaped doc with hundreds of
	 * embedded images doesn't fan out into hundreds of vision requests.
	 */
	MAX_INLINE_IMAGE_CAPTIONS: 20,
	/**
	 * Hard cap for `ingest.worker_concurrency`. The runtime default is
	 * `cpus - 1` so machines with very high core counts can scale, but we
	 * clamp here to keep concurrent Anthropic describe calls (and per-worker
	 * WASM embedder allocations — each pipeline holds the model weights) from
	 * spiraling out of control.
	 */
	MAX_WORKERS: 8,
	/**
	 * When true, describe() skips the LLM for self-describing markdown/text
	 * (a clear H1 within the first 40 lines of body) and uses the heading +
	 * 200-char prefix instead. Avoids paying for an LLM round-trip when the
	 * file already has a human-written description.
	 */
	DESCRIBER_SKIP_WHEN_TITLED: true,
	/**
	 * Size threshold at which `membot serve`'s `~/.membot/logs/serve.log`
	 * rolls over. The active file is renamed to `serve.log.1` (rolling
	 * `.1` → `.2`, capped at 3 files total) and a fresh file is opened.
	 * 5 MB keeps a long-running daemon's audit trail bounded while still
	 * holding many thousands of tool-call records.
	 */
	SERVE_LOG_ROTATE_BYTES: 5_000_000,
	/**
	 * Maximum number of rotated `serve.log.N` files to keep alongside the
	 * active log. Older rolls are dropped on rotation.
	 */
	SERVE_LOG_ROTATE_KEEP: 3,
} as const;

export const FILES = {
	CONFIG_JSON: "config.json",
	INDEX_DUCKDB: "index.duckdb",
	MODELS_DIR: "models",
	LOGS_DIR: "logs",
} as const;
