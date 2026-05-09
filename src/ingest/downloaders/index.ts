import type { logger as Logger } from "../../output/logger.ts";
import type { BrowserPool } from "./browser.ts";
import { genericWebDownloader } from "./generic-web.ts";
import { githubDownloader } from "./github.ts";
import { googleDocsDownloader } from "./google-docs.ts";
import { googleSheetsDownloader } from "./google-sheets.ts";
import { googleSlidesDownloader } from "./google-slides.ts";
import { linearDownloader } from "./linear.ts";

/**
 * The shape every URL fetch produces — drop-in replacement for the
 * old `FetchedRemote` shape. `downloader` + `downloaderArgs` get
 * persisted on the row so refresh replays the same downloader against
 * the same URL deterministically (no LLM, no agent loop).
 */
export interface DownloadedRemote {
	bytes: Uint8Array;
	sha256: string;
	mimeType: string;
	downloader: string;
	downloaderArgs: Record<string, unknown>;
	sourceUrl: string;
}

export interface DownloaderCtx {
	pool: BrowserPool;
	logger: typeof Logger;
}

/**
 * One tactic for fetching a URL. Specific downloaders (Google,
 * GitHub, Linear) match URLs by host/pattern and hit the canonical
 * export endpoint; the generic-web downloader is the registry's
 * always-matching catch-all (HEADs the URL, prints to PDF if HTML,
 * else streams the raw bytes through). Adding a 6th service is one
 * file — implement `Downloader`, register it here.
 */
export interface Downloader {
	name: string;
	description: string;
	matches(url: URL): boolean;
	download(url: URL, ctx: DownloaderCtx): Promise<DownloadedRemote>;
}

const REGISTRY: Downloader[] = [
	googleDocsDownloader,
	googleSheetsDownloader,
	googleSlidesDownloader,
	githubDownloader,
	linearDownloader,
	genericWebDownloader,
];

/**
 * Find the first downloader that matches `url`. Returns `null` only
 * if `url` doesn't parse — in normal use the generic-web downloader
 * matches everything else, so callers can treat `findDownloader` as
 * total over valid URLs.
 */
export function findDownloader(url: string | URL): Downloader | null {
	let parsed: URL;
	try {
		parsed = typeof url === "string" ? new URL(url) : url;
	} catch {
		return null;
	}
	for (const d of REGISTRY) {
		if (d.matches(parsed)) return d;
	}
	return null;
}

/** Lookup by name (used by refresh to replay a persisted downloader). */
export function findDownloaderByName(name: string): Downloader | null {
	return REGISTRY.find((d) => d.name === name) ?? null;
}

/** Read-only view of every registered downloader. */
export function listDownloaders(): readonly Downloader[] {
	return REGISTRY;
}

/**
 * Compute a stable sha256 hex digest of the bytes. Re-exposed here
 * because every downloader uses it.
 */
export { sha256Hex } from "../local-reader.ts";
