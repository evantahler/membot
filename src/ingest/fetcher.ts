import { join } from "node:path";
import type { MembotConfig } from "../config/schemas.ts";
import { FILES } from "../constants.ts";
import { HelpfulError } from "../errors.ts";
import { logger } from "../output/logger.ts";
import { BrowserPool } from "./sources/browser.ts";
import { findSourceByName, findSourceForInput, listSources } from "./sources/registry.ts";
import type { DownloadedRemote, PluginCtx, SourcePlugin } from "./sources/types.ts";

export type FetchedRemote = DownloadedRemote;

export interface FetchOptions {
	/**
	 * Optional explicit plugin override. Free-form; matched
	 * case-insensitively against `SourcePlugin.name`. When given, skips
	 * URL-based matching and forces that plugin (useful for the
	 * "use the generic-web fallback even though google-docs claimed
	 * this URL" escape hatch).
	 */
	downloaderName?: string;
	/**
	 * Override the on-disk path of the persistent chromium profile.
	 * Defaults to `<ctx.dataDir>/auth/browser-profile`.
	 */
	userDataDir?: string;
	/** Pre-built BrowserPool to share across many fetches. */
	pool?: BrowserPool;
	/**
	 * Sublabel hook forwarded to the plugin's `PluginCtx`. Drives the
	 * per-entry spinner text during multi-step fetches.
	 */
	onProgress?: (sublabel: string) => void;
}

/**
 * Fetch a single remote URL via the source-plugin registry. URL-pattern
 * matchers take first crack; the generic-web plugin is the always-matching
 * catch-all. Every fetch authenticates via the cookies the user persisted
 * with `membot login` (browser plugins) or a configured api_key.
 *
 * The returned shape includes the chosen plugin name and its args so
 * refresh can replay it deterministically.
 */
export async function fetchRemote(
	url: string,
	config: MembotConfig,
	options: FetchOptions = {},
	dataDir?: string,
): Promise<FetchedRemote> {
	const plugin = pickPlugin(url, options.downloaderName);
	const userDataDir = options.userDataDir ?? defaultProfileDir(dataDir);
	const ownsPool = !options.pool;
	const headless = !plugin.requireHeaded;
	const pool = options.pool ?? new BrowserPool({ userDataDir, headless });
	const pctx: PluginCtx = { pool, logger, config, onProgress: options.onProgress };
	const fetcher = await plugin.openBatchFetcher(pctx);
	try {
		const entries = await plugin.enumerate(url);
		const entry = entries[0];
		if (!entry) {
			throw new HelpfulError({
				kind: "input_error",
				message: `plugin '${plugin.name}' produced no entry for ${url}`,
				hint: "Re-check the URL is well-formed, or pass `--downloader generic-web` to bypass URL matching.",
			});
		}
		return await fetcher.fetch(entry, pctx);
	} finally {
		await fetcher.close();
		if (ownsPool) await pool.dispose();
	}
}

function pickPlugin(url: string, override?: string): SourcePlugin {
	if (override) {
		const named = findSourceByName(override.toLowerCase());
		if (!named) {
			const available = listSources()
				.map((p) => p.name)
				.join(", ");
			throw new HelpfulError({
				kind: "input_error",
				message: `unknown source plugin '${override}'`,
				hint: `Pick one of: ${available}.`,
			});
		}
		return named;
	}
	const matched = findSourceForInput(url);
	if (!matched) {
		throw new HelpfulError({
			kind: "input_error",
			message: `not a fetchable URL: ${url}`,
			hint: "Pass an http(s):// URL or a recognised scheme like `apple-notes:`.",
		});
	}
	return matched;
}

function defaultProfileDir(dataDir?: string): string {
	if (dataDir) return join(dataDir, FILES.BROWSER_PROFILE);
	const home = process.env.MEMBOT_HOME ?? `${process.env.HOME ?? "."}/.membot`;
	return join(home, FILES.BROWSER_PROFILE);
}
