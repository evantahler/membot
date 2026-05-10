import { z } from "zod";
import { DEFAULTS, defaultMembotHome, EMBEDDING_DIMENSION, EMBEDDING_MODEL } from "../constants.ts";

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
export type LlmConfig = z.infer<typeof LlmConfigSchema>;
export type DownloadersConfig = z.infer<typeof DownloadersConfigSchema>;
export type LinearDownloaderConfig = z.infer<typeof LinearDownloaderConfigSchema>;
export type GithubDownloaderConfig = z.infer<typeof GithubDownloaderConfigSchema>;
export type SearchConfig = z.infer<typeof SearchConfigSchema>;
