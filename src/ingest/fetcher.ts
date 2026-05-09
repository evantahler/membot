import { join } from "node:path";
import { FILES } from "../constants.ts";
import { HelpfulError } from "../errors.ts";
import { logger } from "../output/logger.ts";
import { BrowserPool } from "./downloaders/browser.ts";
import {
	type DownloadedRemote,
	type Downloader,
	type DownloaderCtx,
	findDownloader,
	findDownloaderByName,
	listDownloaders,
} from "./downloaders/index.ts";

export type FetchedRemote = DownloadedRemote;

export interface FetchOptions {
	/**
	 * Optional explicit downloader override. Free-form; matched
	 * case-insensitively against `Downloader.name`. When given, skips the
	 * URL-based matching and forces that downloader (useful for the
	 * "use the generic-web fallback even though google-docs claimed
	 * this URL" escape hatch).
	 */
	downloaderName?: string;
	/**
	 * Override the on-disk path used for browser session storage.
	 * Defaults to `<ctx.dataDir>/auth/browser.json`.
	 */
	storageStatePath?: string;
	/** Pre-built BrowserPool to share across many fetches (set by ingest's outer loop). */
	pool?: BrowserPool;
}

/**
 * Fetch a remote URL via the per-service downloader registry. Specific
 * downloaders (Google, GitHub, Linear) match first; the generic-web
 * downloader is the always-matching catch-all. Every fetch authenticates
 * via the cookies the user persisted with `membot login`. The returned
 * shape includes the chosen downloader name and its args so refresh can
 * replay it deterministically without involving the LLM.
 */
export async function fetchRemote(url: string, options: FetchOptions = {}, dataDir?: string): Promise<FetchedRemote> {
	const downloader = pickDownloader(url, options.downloaderName);
	const ownsPool = !options.pool;
	const pool =
		options.pool ??
		new BrowserPool({
			storageStatePath: options.storageStatePath ?? defaultStoragePath(dataDir),
		});
	const dctx: DownloaderCtx = { pool, logger };
	try {
		const result = await downloader.download(new URL(url), dctx);
		return result;
	} finally {
		if (ownsPool) await pool.dispose();
	}
}

/**
 * Replay a fetch by downloader name (used by refresh). Looks up the
 * persisted downloader by name and calls it against the original URL —
 * deterministic, no agent loop. When the persisted downloader is no
 * longer registered (e.g. from a prior membot version), falls back to
 * URL-based dispatch so refresh degrades gracefully instead of erroring.
 */
export async function fetchRemoteByDownloader(
	downloaderName: string | null,
	url: string,
	pool: BrowserPool,
): Promise<FetchedRemote> {
	const named = downloaderName ? findDownloaderByName(downloaderName) : null;
	const downloader = named ?? findDownloader(url);
	if (!downloader) {
		throw new HelpfulError({
			kind: "input_error",
			message: `no downloader matches ${url}`,
			hint: "Re-add the URL with `membot add <url>` to pick a fresh downloader.",
		});
	}
	const dctx: DownloaderCtx = { pool, logger };
	return downloader.download(new URL(url), dctx);
}

function pickDownloader(url: string, override?: string): Downloader {
	if (override) {
		const named = findDownloaderByName(override.toLowerCase());
		if (!named) {
			const available = listDownloaders()
				.map((d) => d.name)
				.join(", ");
			throw new HelpfulError({
				kind: "input_error",
				message: `unknown downloader '${override}'`,
				hint: `Pick one of: ${available}.`,
			});
		}
		return named;
	}
	const matched = findDownloader(url);
	if (!matched) {
		throw new HelpfulError({
			kind: "input_error",
			message: `not a fetchable URL: ${url}`,
			hint: "Pass an http(s):// URL.",
		});
	}
	return matched;
}

function defaultStoragePath(dataDir?: string): string {
	if (dataDir) return join(dataDir, FILES.BROWSER_STATE);
	const home = process.env.MEMBOT_HOME ?? `${process.env.HOME ?? "."}/.membot`;
	return join(home, FILES.BROWSER_STATE);
}
