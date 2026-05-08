import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { defaultMembotHome, ENV, FILES } from "../constants.ts";
import { asHelpful, HelpfulError } from "../errors.ts";
import { type MembotConfig, MembotConfigSchema } from "./schemas.ts";

export interface LoadConfigOptions {
	configFlag?: string;
}

/**
 * Resolve, read, and validate `~/.membot/config.json`. The directory is
 * created if missing. Environment variables (ANTHROPIC_API_KEY) take
 * precedence over the on-disk values for sensitive fields.
 */
export async function loadConfig(options: LoadConfigOptions = {}): Promise<{
	config: MembotConfig;
	dataDir: string;
	configPath: string;
}> {
	const dataDir = resolveDataDir(options.configFlag);
	await mkdir(dataDir, { recursive: true });

	const configPath = resolve(dataDir, FILES.CONFIG_JSON);
	let raw: unknown = {};
	const file = Bun.file(configPath);
	if (await file.exists()) {
		try {
			raw = JSON.parse(await file.text());
		} catch (err) {
			throw asHelpful(
				err,
				`while parsing ${configPath}`,
				`Fix the JSON in ${configPath}, or delete it to regenerate defaults.`,
				"input_error",
			);
		}
	}

	let config: MembotConfig;
	try {
		config = MembotConfigSchema.parse(raw);
	} catch (err) {
		throw asHelpful(
			err,
			`while validating ${configPath}`,
			`Check ${configPath} against the documented schema, or delete it to regenerate defaults.`,
			"input_error",
		);
	}

	const envKey = process.env[ENV.ANTHROPIC_API_KEY];
	if (envKey && envKey.trim()) {
		config = { ...config, llm: { ...config.llm, anthropic_api_key: envKey } };
	}

	if (config.data_dir !== dataDir) {
		config = { ...config, data_dir: dataDir };
	}

	return { config, dataDir, configPath };
}

/**
 * Pick the membot data directory. Precedence: explicit `--config` flag,
 * then `MEMBOT_HOME` env var, then `~/.membot`. The chosen path is later
 * created (recursive mkdir) and stamped back into `config.data_dir`.
 */
function resolveDataDir(flag?: string): string {
	if (flag && flag.trim()) return resolve(flag);
	const env = process.env[ENV.HOME];
	if (env && env.trim()) return resolve(env);
	return defaultMembotHome();
}

/**
 * Persist config to disk, with the Anthropic API key blanked out — the env
 * var (`ANTHROPIC_API_KEY`) is the source of truth, never the file. Writing
 * the key to disk would land it in shell history, dotfile syncs, and
 * accidental commits.
 */
export async function saveConfig(configPath: string, config: MembotConfig): Promise<void> {
	const safe: MembotConfig = {
		...config,
		llm: { ...config.llm, anthropic_api_key: "" },
	};
	await Bun.write(configPath, `${JSON.stringify(safe, null, 2)}\n`);
}

/**
 * Tree-shaking guard. Not called at runtime — its presence keeps the module
 * from being eliminated by aggressive bundlers when only types are imported.
 */
export function _ensureExportedSentinel(): never {
	throw new HelpfulError({
		kind: "internal_error",
		message: "sentinel called",
		hint: "This function exists only for tree-shaking sanity checks.",
	});
}
