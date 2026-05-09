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
	ingest: IngestConfigSchema.default(() => IngestConfigSchema.parse({})),
	llm: LlmConfigSchema.default(() => LlmConfigSchema.parse({})),
	downloaders: DownloadersConfigSchema.default(() => DownloadersConfigSchema.parse({})),
	daemon: DaemonConfigSchema.default(() => DaemonConfigSchema.parse({})),
	db_lock_retry: DbLockRetryConfigSchema.default(() => DbLockRetryConfigSchema.parse({})),
	default_refresh_frequency_sec: z.number().int().positive().nullable().default(null),
});

export type MembotConfig = z.infer<typeof MembotConfigSchema>;
export type ChunkerConfig = z.infer<typeof ChunkerConfigSchema>;
export type EmbeddingConfig = z.infer<typeof EmbeddingConfigSchema>;
export type ConvertersConfig = z.infer<typeof ConvertersConfigSchema>;
export type IngestConfig = z.infer<typeof IngestConfigSchema>;
export type LlmConfig = z.infer<typeof LlmConfigSchema>;
export type DownloadersConfig = z.infer<typeof DownloadersConfigSchema>;
export type LinearDownloaderConfig = z.infer<typeof LinearDownloaderConfigSchema>;
export type GithubDownloaderConfig = z.infer<typeof GithubDownloaderConfigSchema>;
