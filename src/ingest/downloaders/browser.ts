import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { APIRequestContext, Browser, BrowserContext, Page } from "playwright";
import { HelpfulError } from "../../errors.ts";

let chromiumModule: typeof import("playwright").chromium | null = null;

/**
 * Lazy-import `playwright.chromium`. Keeping the import deferred so the
 * heavy module isn't loaded on cold paths (e.g. `membot list`); ALSO
 * lets us produce a `HelpfulError` if Playwright isn't installed yet
 * instead of a stack trace at module-load time.
 */
async function loadChromium(): Promise<typeof import("playwright").chromium> {
	if (chromiumModule) return chromiumModule;
	try {
		const playwright = await import("playwright");
		chromiumModule = playwright.chromium;
		return chromiumModule;
	} catch (err) {
		throw new HelpfulError({
			kind: "internal_error",
			message: `failed to load playwright: ${err instanceof Error ? err.message : String(err)}`,
			hint: "Run `bun add -g membot` to reinstall, then `npx playwright install chromium` to fetch the browser binary.",
		});
	}
}

export interface BrowserPoolOptions {
	storageStatePath: string;
	headless?: boolean;
}

/**
 * Process-scoped lazy-launched chromium instance + storageState-aware
 * BrowserContext. Downloaders that need authenticated HTTP grab
 * `pool.request()`; downloaders that need a rendered DOM grab
 * `pool.page()`. The browser is launched on first use and torn down
 * via `dispose()` once an ingest run finishes — sharing the binary
 * across every URL in the run is much cheaper than relaunching.
 */
export class BrowserPool {
	private readonly storageStatePath: string;
	private readonly headless: boolean;
	private browser: Browser | null = null;
	private context: BrowserContext | null = null;

	constructor(options: BrowserPoolOptions) {
		this.storageStatePath = options.storageStatePath;
		this.headless = options.headless ?? true;
	}

	/**
	 * Lazy-init a single shared `BrowserContext`. The first call launches
	 * chromium (using bundled Playwright Chromium); subsequent calls reuse
	 * the same context so cookies, viewport, and request inflight queues
	 * are shared across downloaders within one ingest run.
	 */
	private async ensureContext(): Promise<BrowserContext> {
		if (this.context) return this.context;
		const chromium = await loadChromium();
		try {
			this.browser = await chromium.launch({ headless: this.headless });
		} catch (err) {
			throw new HelpfulError({
				kind: "internal_error",
				message: `chromium failed to launch: ${err instanceof Error ? err.message : String(err)}`,
				hint: "Run `npx playwright install chromium` to download the bundled browser.",
			});
		}
		const storageState = existsSync(this.storageStatePath) ? this.storageStatePath : undefined;
		this.context = await this.browser.newContext({ storageState });
		return this.context;
	}

	/** Return the request context for downloaders that just need authenticated HTTP. */
	async request(): Promise<APIRequestContext> {
		const ctx = await this.ensureContext();
		return ctx.request;
	}

	/** Open a fresh page (caller is responsible for `page.close()`). */
	async newPage(): Promise<Page> {
		const ctx = await this.ensureContext();
		return ctx.newPage();
	}

	/**
	 * Save the current cookies/storage to `storageStatePath`. Used by
	 * `membot login` after the user finishes logging into services.
	 */
	async persistStorageState(): Promise<void> {
		if (!this.context) return;
		await mkdir(dirname(this.storageStatePath), { recursive: true });
		await this.context.storageState({ path: this.storageStatePath });
	}

	/** Close the context and the underlying browser. Idempotent. */
	async dispose(): Promise<void> {
		try {
			await this.context?.close();
		} catch {
			// best-effort
		}
		try {
			await this.browser?.close();
		} catch {
			// best-effort
		}
		this.context = null;
		this.browser = null;
	}
}

/**
 * Resolve `maybeRelative` against `base` and return a `URL`, or `null`
 * if neither parses. Playwright's `APIResponse.url()` sometimes hands
 * back a path-only string (`"/"`) instead of an absolute URL after a
 * same-origin redirect — every downloader that wants to inspect the
 * final URL goes through this helper so the relative-URL handling
 * lives in one place. Login-redirect detection itself is each
 * downloader's responsibility — it's the only code that knows which
 * host its export endpoint redirects to when the session is missing.
 */
export function safeResolveUrl(maybeRelative: string, base: string): URL | null {
	try {
		return new URL(maybeRelative, base);
	} catch {
		return null;
	}
}
