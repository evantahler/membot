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
	CHUNKER_TARGET_CHARS: 4_000,
	CHUNKER_MAX_CHARS: 15_000,
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
} as const;

export const FILES = {
	CONFIG_JSON: "config.json",
	INDEX_DUCKDB: "index.duckdb",
	MODELS_DIR: "models",
	LOGS_DIR: "logs",
	AUTH_DIR: "auth",
	/**
	 * Persistent Chromium profile directory. We use
	 * `chromium.launchPersistentContext(userDataDir)` rather than the
	 * lighter `storageState` JSON snapshot because Linear (and other
	 * SPA-heavy services) stash critical session state in IndexedDB —
	 * which `storageState` doesn't capture. A persistent profile
	 * survives the full set: cookies, localStorage, IndexedDB, service
	 * workers, etc. Trade-off: directory-sized state instead of a tiny
	 * JSON file, and only one process can have the profile open at a
	 * time (chromium's single-instance lock).
	 */
	BROWSER_PROFILE: "auth/browser-profile",
} as const;
