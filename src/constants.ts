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
	MCPX_CONFIG_PATH: "MCP_CONFIG_PATH",
} as const;

export const EMBEDDING_MODEL = "Xenova/bge-small-en-v1.5";
export const EMBEDDING_DIMENSION = 384;

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
} as const;

export const FILES = {
	CONFIG_JSON: "config.json",
	INDEX_DUCKDB: "index.duckdb",
	MODELS_DIR: "models",
	LOGS_DIR: "logs",
} as const;
