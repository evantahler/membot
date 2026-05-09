import type { MembotConfig } from "../../config/schemas.ts";
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
	config: MembotConfig;
	/**
	 * Optional sublabel hook for the host's progress spinner. Long-running
	 * downloaders (multi-query GraphQL, paginated REST fetches, headless
	 * browser navigation) can call this with short status strings —
	 * "fetching", "rendering", "parsing 3/4 pages" — and the CLI will
	 * surface them under the per-entry progress bar. No-op when the host
	 * doesn't supply one (e.g. MCP server, JSON-mode CLI).
	 */
	onProgress?: (sublabel: string) => void;
}

/**
 * One tactic for fetching a URL. Specific downloaders (Google,
 * GitHub, Linear) match URLs by host/pattern and hit the canonical
 * export endpoint; the generic-web downloader is the registry's
 * always-matching catch-all (HEADs the URL, prints to PDF if HTML,
 * else streams the raw bytes through). Adding a 6th service is one
 * file — implement `Downloader`, register it here.
 *
 * If a downloader requires a logged-in browser session, it declares
 * one or more `LoginEntry` objects; the `membot login` page collects
 * those across every downloader, dedupes by URL, and renders one
 * button per service.
 */
export interface Downloader {
	name: string;
	description: string;
	matches(url: URL): boolean;
	download(url: URL, ctx: DownloaderCtx): Promise<DownloadedRemote>;
	logins?: LoginEntry[];
	/**
	 * Force the BrowserPool into headed mode for this downloader's
	 * fetches. Used for SPAs that detect headless Chromium and refuse
	 * to hydrate; we don't currently use it (services that needed it
	 * have moved to the API-key flow), but the hook remains for
	 * future cookie-based downloaders.
	 */
	requireHeaded?: boolean;
	/**
	 * The downloader authenticates via a config-stored API key, not
	 * browser cookies. The fetcher uses this to skip the auto-login
	 * browser prompt on `auth_error` (opening a browser doesn't help
	 * when the missing credential is in the config file).
	 */
	requiresApiKey?: boolean;
}

/**
 * A service the user might need to set up before fetches against it
 * succeed. Two flavors:
 *  - `kind: "browser"` — the user clicks a link in the `membot login`
 *    browser, signs in, and closes the window. Cookies + IndexedDB
 *    land in the persistent profile and downloaders use them
 *    automatically.
 *  - `kind: "api_key"` — the user visits the service's API-key page,
 *    copies the key, and runs the displayed `setupCommand`. The key
 *    lives in `~/.membot/config.json` and downloaders read it from
 *    `ctx.config`.
 *
 * Multiple downloaders can declare the same `LoginEntry` (e.g. all
 * three Google downloaders share Google sign-in); the login page
 * dedupes by `(kind, url)`.
 */
export type LoginEntry = BrowserLoginEntry | ApiKeyLoginEntry;

export interface BrowserLoginEntry {
	kind: "browser";
	/** Display name (e.g. "Google"). */
	name: string;
	/** Login URL the button opens. */
	url: string;
	/** Optional one-liner shown next to the button. */
	description?: string;
}

export interface ApiKeyLoginEntry {
	kind: "api_key";
	/** Display name (e.g. "Linear"). */
	name: string;
	/** Settings page where the user creates the key. */
	url: string;
	/** Shell command the user copies — e.g. `membot config set linear.api_key <KEY>`. */
	setupCommand: string;
	/** Optional one-liner shown next to the link. */
	description?: string;
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
 * Collect every `LoginEntry` declared by a downloader, deduped by URL
 * within each kind. Used by `membot login` to render one button per
 * service (browser-login) and one set of instructions per service
 * (api-key) even when multiple downloaders share the same setup
 * (e.g. Google Docs / Sheets / Slides all share Google sign-in).
 */
export function collectLoginEntries(): { browser: BrowserLoginEntry[]; apiKey: ApiKeyLoginEntry[] } {
	const browser = new Map<string, BrowserLoginEntry>();
	const apiKey = new Map<string, ApiKeyLoginEntry>();
	for (const d of REGISTRY) {
		if (!d.logins) continue;
		for (const entry of d.logins) {
			if (entry.kind === "browser") {
				if (!browser.has(entry.url)) browser.set(entry.url, entry);
			} else {
				if (!apiKey.has(entry.url)) apiKey.set(entry.url, entry);
			}
		}
	}
	return { browser: [...browser.values()], apiKey: [...apiKey.values()] };
}

/**
 * Compute a stable sha256 hex digest of the bytes. Re-exposed here
 * because every downloader uses it.
 */
export { sha256Hex } from "../local-reader.ts";
