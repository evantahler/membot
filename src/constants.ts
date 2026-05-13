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
	/**
	 * Per-platform directory that holds bundled third-party binaries we
	 * fetch at install time (currently just `gws`). Lives under
	 * `~/.membot/` so a `bun add -g membot` reinstall doesn't blow it
	 * away the way `~/.cache/membot/` would on some Linux distros.
	 */
	BIN_DIR: "bin",
} as const;

/**
 * Pinned release tag of `googleworkspace/cli` (`gws`) that membot's
 * postinstall script downloads into `~/.membot/bin/`. `gws` is pre-1.0
 * with advertised breaking changes; bumping this constant is a
 * deliberate, audited step — never auto-track latest.
 */
export const GWS_VERSION = "v0.22.5";

/**
 * Default install location for the `gws` binary. Resolved relative to
 * `MEMBOT_HOME` at runtime by the `gws` wrapper; defined here as a
 * single string so the postinstall script and the runtime resolver
 * stay in sync.
 */
export const GWS_BIN_NAME = process.platform === "win32" ? "gws.exe" : "gws";
