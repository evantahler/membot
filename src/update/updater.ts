import { createUpdater, type Updater, type UpdaterConfig } from "upgradr";
import pkg from "../../package.json" with { type: "json" };
import { DEFAULTS, defaultMembotHome, ENV } from "../constants.ts";
import { HelpfulError } from "../errors.ts";
import { logger } from "../output/logger.ts";

/** GitHub `owner/name` for release binaries + changelog, derived from `package.json`. */
function githubRepo(): string {
	const repo = pkg.repository.url.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
	if (!repo.includes("/")) {
		throw new HelpfulError({
			kind: "internal_error",
			message: `Could not derive a GitHub owner/name from package.json repository.url ("${pkg.repository.url}").`,
			hint: 'Set "repository.url" in package.json to "https://github.com/<owner>/<name>.git".',
		});
	}
	return repo;
}

/**
 * Build the membot self-updater backed by `upgradr`. Constructed fresh on each
 * call (not a module-load singleton) so `cacheDir` reads `defaultMembotHome()`
 * at call time — this honors a `MEMBOT_HOME` set after import, which the CLI
 * commands and tests rely on. `overrides` is a test seam (e.g. `fetchImpl`) and
 * is unused in production.
 */
export function getUpdater(overrides?: Partial<UpdaterConfig>): Updater {
	return createUpdater({
		currentVersion: pkg.version,
		packageName: pkg.name,
		repo: githubRepo(),
		// The release-asset prefix (`<binaryName>-<os>-<arch>`) is the CLI's bin name.
		binaryName: Object.keys(pkg.bin)[0] ?? pkg.name,
		cacheDir: defaultMembotHome(),
		// cliName (notice/hint display) defaults to packageName — i.e. "membot".
		noUpdateCheckEnv: ENV.NO_UPDATE_CHECK,
		checkIntervalMs: DEFAULTS.UPDATE_CHECK_INTERVAL_MS,
		timeoutMs: DEFAULTS.UPDATE_CHECK_TIMEOUT_MS,
		// upgradr emits the sudo heads-up here during a non-writable binary swap;
		// route it through the spinner-aware logger instead of raw console.
		onProgress: (message) => logger.info(message),
		...overrides,
	});
}
