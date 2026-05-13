import type { MembotConfig } from "../config/schemas.ts";
import { HelpfulError } from "../errors.ts";
import { logger } from "../output/logger.ts";
import { findSourceByName, findSourceForInput, listSources } from "./sources/registry.ts";
import type { DownloadedRemote, PluginCtx, SourcePlugin } from "./sources/types.ts";

export type FetchedRemote = DownloadedRemote;

export interface FetchOptions {
	/**
	 * Optional explicit plugin override. Free-form; matched
	 * case-insensitively against `SourcePlugin.name`. When given, skips
	 * URL-based matching and forces that plugin.
	 */
	downloaderName?: string;
	/**
	 * Sublabel hook forwarded to the plugin's `PluginCtx`. Drives the
	 * per-entry spinner text during multi-step fetches.
	 */
	onProgress?: (sublabel: string) => void;
}

/**
 * Fetch a single remote URL via the source-plugin registry. URL-pattern
 * matchers take first crack. Every fetch authenticates via a
 * config-stored `api_key` for the matching plugin (GitHub, Linear).
 *
 * The returned shape includes the chosen plugin name and its args so
 * refresh can replay it deterministically.
 */
export async function fetchRemote(
	url: string,
	config: MembotConfig,
	options: FetchOptions = {},
): Promise<FetchedRemote> {
	const plugin = pickPlugin(url, config, options.downloaderName);
	const pctx: PluginCtx = { logger, config, onProgress: options.onProgress };
	const fetcher = await plugin.openBatchFetcher(pctx);
	try {
		const entries = await plugin.enumerate(url, { config, logger });
		const entry = entries[0];
		if (!entry) {
			throw new HelpfulError({
				kind: "input_error",
				message: `plugin '${plugin.name}' produced no entry for ${url}`,
				hint: "Re-check the URL is well-formed, or pass an explicit `--downloader` matching one of the registered sources.",
			});
		}
		return await fetcher.fetch(entry, pctx);
	} finally {
		await fetcher.close();
	}
}

function pickPlugin(url: string, config: MembotConfig, override?: string): SourcePlugin {
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
	const matched = findSourceForInput(url, config);
	if (!matched) {
		throw new HelpfulError({
			kind: "input_error",
			message: `no source plugin matches: ${url}`,
			hint: "Pass an http(s):// URL for a supported service (GitHub, Linear), a recognised scheme like `apple-notes:`, or register a custom URL router via `membot router add`.",
		});
	}
	return matched;
}
