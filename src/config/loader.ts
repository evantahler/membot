import { chmod, mkdir } from "node:fs/promises";
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
	if (envKey?.trim()) {
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
	if (flag?.trim()) return resolve(flag);
	const env = process.env[ENV.HOME];
	if (env?.trim()) return resolve(env);
	return defaultMembotHome();
}

/**
 * Persist config to disk and chmod 0600 so the file is owner-read-only —
 * `llm.anthropic_api_key` may be present, and we don't want it world-readable.
 * `loadConfig` still lets `ANTHROPIC_API_KEY` (env) override the file at read
 * time, so an env-var-only setup keeps working unchanged.
 */
export async function saveConfig(configPath: string, config: MembotConfig): Promise<void> {
	await Bun.write(configPath, `${JSON.stringify(config, null, 2)}\n`);
	try {
		await chmod(configPath, 0o600);
	} catch {
		// chmod is best-effort: filesystems without unix permissions (e.g. some
		// Windows scenarios) silently fail, and that's acceptable.
	}
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
