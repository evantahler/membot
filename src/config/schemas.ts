import { availableParallelism } from "node:os";
import { z } from "zod";
import { DEFAULTS, defaultMembotHome, EMBEDDING_DIMENSION, EMBEDDING_MODEL } from "../constants.ts";

/**
 * Compute the default ingest worker count: one fewer than the available CPUs
 * (so the orchestrator and any background work still has a core), clamped to
 * `[1, MAX_WORKERS]` to avoid hammering Anthropic with too many concurrent
 * describe calls on machines with very high core counts.
 */
function defaultWorkerConcurrency(): number {
	const cpus = availableParallelism();
	return Math.min(DEFAULTS.MAX_WORKERS, Math.max(1, cpus - 1));
}

export const ChunkerConfigSchema = z.object({
	mode: z.enum(["deterministic", "llm"]).default(DEFAULTS.CHUNKER_MODE),
	target_chars: z.number().int().positive().default(DEFAULTS.CHUNKER_TARGET_CHARS),
	max_chars: z.number().int().positive().default(DEFAULTS.CHUNKER_MAX_CHARS),
});

export const ConvertersConfigSchema = z.object({
	max_inline_image_captions: z.number().int().nonnegative().default(DEFAULTS.MAX_INLINE_IMAGE_CAPTIONS),
});

/**
 * Blob persistence policy. Each ingested file's metadata (sha256, size,
 * mime, downloader provenance) is always inserted into `blobs` — these
 * knobs only control whether the original `bytes` are *persisted*
 * alongside that metadata. A row with `bytes IS NULL` still dedupes by
 * sha256, still supports refresh (which sha-compares source bytes, not
 * stored bytes), and still drives chunks/embeddings (conversion runs
 * against the in-memory bytes at ingest time). Only `membot_read
 * bytes=true` and future re-conversion against an improved converter
 * need the persisted bytes.
 */
export const BlobsConfigSchema = z.object({
	max_size_bytes: z
		.number()
		.int()
		.positive()
		.nullable()
		.default(25 * 1024 * 1024)
		.describe(
			"Skip persisting original blob bytes for sources larger than this. The blobs row is still inserted with NULL bytes. Set to null to always persist regardless of size.",
		),
	skip_mime_types: z
		.array(z.string())
		.default(["video/*", "audio/*"])
		.describe(
			"Mime-type prefix-globs whose bytes are never persisted regardless of size (e.g. 'video/*' matches 'video/quicktime'). The blobs row metadata is still inserted.",
		),
});

export const LlmConfigSchema = z.object({
	anthropic_api_key: z.string().meta({ secret: true }).default(""),
	converter_model: z.string().default(DEFAULTS.CONVERTER_MODEL),
	chunker_model: z.string().default(DEFAULTS.CHUNKER_MODEL),
	describer_model: z.string().default(DEFAULTS.DESCRIBER_MODEL),
	vision_model: z.string().default(DEFAULTS.VISION_MODEL),
	describer_skip_when_titled: z.boolean().default(DEFAULTS.DESCRIBER_SKIP_WHEN_TITLED),
});

export const IngestConfigSchema = z.object({
	worker_concurrency: z.number().int().positive().default(defaultWorkerConcurrency),
});

export const DaemonConfigSchema = z.object({
	tick_interval_sec: z.number().int().positive().default(DEFAULTS.DAEMON_TICK_SEC),
});

/**
 * Embedding parallelism. `workers = null` (the default) resolves to
 * `max(1, cpus()-1)` at context-build time so the pool grows with the host
 * machine. Setting `workers = 1` disables the subprocess pool entirely
 * and runs embedding inline in the parent (the original single-thread
 * behaviour). Each worker loads its own copy of the WASM model
 * (~50MB resident), so cap this on RAM-constrained machines.
 */
export const EmbeddingConfigSchema = z.object({
	workers: z.number().int().min(1).nullable().default(null),
});

/**
 * Hybrid-search ranking knobs.
 *
 * `semantic_weight` controls how RRF balances the semantic and keyword lists:
 * the weight applied to the semantic side is `semantic_weight`; the keyword
 * side gets `1 - semantic_weight`. 0.5 = equal weight (the legacy behavior).
 * Default 0.6 — a small tilt toward semantic so a chunk that earns rank only
 * via semantic similarity (no literal token overlap) can still surface above
 * docs that incidentally contain one of the query tokens.
 */
export const SearchConfigSchema = z.object({
	semantic_weight: z
		.number()
		.min(0)
		.max(1)
		.default(0.6)
		.describe(
			"RRF weight on the semantic list (keyword gets 1 - this). 0.5 = equal, >0.5 favors semantic, <0.5 favors keyword.",
		),
});

export const LinearDownloaderConfigSchema = z.object({
	api_key: z.string().meta({ secret: true }).default(""),
});

export const GithubDownloaderConfigSchema = z.object({
	api_key: z.string().meta({ secret: true }).default(""),
});

export const DownloadersConfigSchema = z.object({
	linear: LinearDownloaderConfigSchema.default(() => LinearDownloaderConfigSchema.parse({})),
	github: GithubDownloaderConfigSchema.default(() => GithubDownloaderConfigSchema.parse({})),
});

export const DbLockRetryConfigSchema = z.object({
	max_attempts: z.number().int().positive().default(30),
	base_delay_ms: z.number().int().positive().default(100),
	max_delay_ms: z.number().int().positive().default(2000),
});

export const MembotConfigSchema = z.object({
	data_dir: z.string().default(defaultMembotHome()),
	embedding_model: z.string().default(EMBEDDING_MODEL),
	embedding_dimension: z.number().int().positive().default(EMBEDDING_DIMENSION),
	chunker: ChunkerConfigSchema.default(() => ChunkerConfigSchema.parse({})),
	embedding: EmbeddingConfigSchema.default(() => EmbeddingConfigSchema.parse({})),
	converters: ConvertersConfigSchema.default(() => ConvertersConfigSchema.parse({})),
	blobs: BlobsConfigSchema.default(() => BlobsConfigSchema.parse({})),
	ingest: IngestConfigSchema.default(() => IngestConfigSchema.parse({})),
	llm: LlmConfigSchema.default(() => LlmConfigSchema.parse({})),
	downloaders: DownloadersConfigSchema.default(() => DownloadersConfigSchema.parse({})),
	search: SearchConfigSchema.default(() => SearchConfigSchema.parse({})),
	daemon: DaemonConfigSchema.default(() => DaemonConfigSchema.parse({})),
	db_lock_retry: DbLockRetryConfigSchema.default(() => DbLockRetryConfigSchema.parse({})),
	default_refresh_frequency_sec: z.number().int().positive().nullable().default(null),
});

export type MembotConfig = z.infer<typeof MembotConfigSchema>;
export type ChunkerConfig = z.infer<typeof ChunkerConfigSchema>;
export type EmbeddingConfig = z.infer<typeof EmbeddingConfigSchema>;
export type ConvertersConfig = z.infer<typeof ConvertersConfigSchema>;
export type BlobsConfig = z.infer<typeof BlobsConfigSchema>;
export type IngestConfig = z.infer<typeof IngestConfigSchema>;
export type LlmConfig = z.infer<typeof LlmConfigSchema>;
export type DownloadersConfig = z.infer<typeof DownloadersConfigSchema>;
export type LinearDownloaderConfig = z.infer<typeof LinearDownloaderConfigSchema>;
export type GithubDownloaderConfig = z.infer<typeof GithubDownloaderConfigSchema>;
export type SearchConfig = z.infer<typeof SearchConfigSchema>;
