import { z } from "zod";
import { DEFAULTS, defaultMembotHome, EMBEDDING_DIMENSION, EMBEDDING_MODEL } from "../constants.ts";

export const ChunkerConfigSchema = z.object({
	mode: z.enum(["deterministic", "llm"]).default(DEFAULTS.CHUNKER_MODE),
	target_chars: z.number().int().positive().default(DEFAULTS.CHUNKER_TARGET_CHARS),
	max_chars: z.number().int().positive().default(DEFAULTS.CHUNKER_MAX_CHARS),
});

export const LlmConfigSchema = z.object({
	anthropic_api_key: z.string().meta({ secret: true }).default(""),
	converter_model: z.string().default(DEFAULTS.CONVERTER_MODEL),
	chunker_model: z.string().default(DEFAULTS.CHUNKER_MODEL),
	describer_model: z.string().default(DEFAULTS.DESCRIBER_MODEL),
	vision_model: z.string().default(DEFAULTS.VISION_MODEL),
});

export const McpxConfigSchema = z.object({
	config_path: z.string().default(""),
});

export const DaemonConfigSchema = z.object({
	tick_interval_sec: z.number().int().positive().default(DEFAULTS.DAEMON_TICK_SEC),
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
	llm: LlmConfigSchema.default(() => LlmConfigSchema.parse({})),
	mcpx: McpxConfigSchema.default(() => McpxConfigSchema.parse({})),
	daemon: DaemonConfigSchema.default(() => DaemonConfigSchema.parse({})),
	db_lock_retry: DbLockRetryConfigSchema.default(() => DbLockRetryConfigSchema.parse({})),
	default_refresh_frequency_sec: z.number().int().positive().nullable().default(null),
});

export type MembotConfig = z.infer<typeof MembotConfigSchema>;
export type ChunkerConfig = z.infer<typeof ChunkerConfigSchema>;
export type LlmConfig = z.infer<typeof LlmConfigSchema>;
