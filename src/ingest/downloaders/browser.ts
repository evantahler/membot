import { mkdir } from "node:fs/promises";
import type { APIRequestContext, BrowserContext, Page } from "playwright";
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
			hint: "Run `bun add -g membot` to reinstall, then `bunx playwright install chromium` to fetch the browser binary.",
		});
	}
}

export interface BrowserPoolOptions {
	userDataDir: string;
	headless?: boolean;
}

/**
 * Process-scoped lazy-launched chromium context backed by a *persistent
 * profile directory* (`launchPersistentContext`). Persistent profiles
 * survive cookies, localStorage, sessionStorage, IndexedDB, and service
 * worker state across runs — necessary for SPA-heavy services like
 * Linear that stash critical session/sync state in IndexedDB (which
 * the lighter `storageState` JSON snapshot doesn't capture).
 *
 * Trade-offs:
 *  - The profile is a directory, not a single JSON file (a few MBs).
 *  - Chromium's single-instance lock means only one BrowserPool can
 *    have the profile open at a time. Sequential `membot add` calls
 *    are fine; concurrent CLI processes against the same profile will
 *    fail to launch.
 */
export class BrowserPool {
	private readonly userDataDir: string;
	private readonly headless: boolean;
	private context: BrowserContext | null = null;

	constructor(options: BrowserPoolOptions) {
		this.userDataDir = options.userDataDir;
		this.headless = options.headless ?? true;
	}

	/**
	 * Lazy-init the persistent context. The first call launches
	 * chromium against `userDataDir` (creating it if needed); subsequent
	 * calls reuse the same context so cookies, IDB, and inflight
	 * navigation state stay shared across downloaders within one run.
	 */
	private async ensureContext(): Promise<BrowserContext> {
		if (this.context) return this.context;
		const chromium = await loadChromium();
		await mkdir(this.userDataDir, { recursive: true });
		try {
			this.context = await chromium.launchPersistentContext(this.userDataDir, {
				headless: this.headless,
			});
		} catch (err) {
			throw new HelpfulError({
				kind: "internal_error",
				message: `chromium failed to launch: ${err instanceof Error ? err.message : String(err)}`,
				hint: this.headless
					? "Run `bunx playwright install chromium` to download the browser binary."
					: "Close any other membot process holding the browser profile, then retry.",
			});
		}
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
	 * How many cookies are in the live context. Used by the auth-prompt
	 * flow to detect "user closed the window without logging in" — must
	 * be called BEFORE `dispose()` since the context closes its own
	 * stores when shutting down.
	 */
	async cookieCount(): Promise<number> {
		if (!this.context) return 0;
		try {
			const cookies = await this.context.cookies();
			return cookies.length;
		} catch {
			return 0;
		}
	}

	/**
	 * Return the cookies stored in the persistent profile for a given
	 * URL/origin (or all cookies when omitted). Used by downloaders that
	 * call services with their own HTTP client (e.g. Node's built-in
	 * `fetch`) — they read the cookies once here and pass them via a
	 * `Cookie` header. Bypasses Playwright's APIRequestContext, which
	 * has a known cookie-parser bug on Google's same-origin redirects.
	 */
	async cookieHeader(url: string): Promise<string> {
		const ctx = await this.ensureContext();
		const cookies = await ctx.cookies(url);
		return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
	}

	/**
	 * Resolve when the user is "done" with the headed browser session,
	 * detected as: the supplied page closes, OR its context closes, OR
	 * the underlying browser disconnects — whichever fires first. We
	 * can't rely on the browser-disconnect event alone: on macOS,
	 * closing the last window does NOT quit chromium (the app stays
	 * alive in the background), so the disconnect event never fires
	 * and the caller hangs forever. The page-close event is the only
	 * signal that's consistent across macOS, Linux, and Windows.
	 */
	async waitForUserDone(page: Page): Promise<void> {
		const ctx = page.context();
		const browser = ctx.browser();
		await new Promise<void>((resolve) => {
			let done = false;
			const finish = () => {
				if (done) return;
				done = true;
				resolve();
			};
			page.on("close", finish);
			ctx.on("close", finish);
			browser?.on("disconnected", finish);
			if (page.isClosed() || (browser && !browser.isConnected())) finish();
		});
	}

	/** Close the context (which releases the userDataDir lock). Idempotent. */
	async dispose(): Promise<void> {
		try {
			await this.context?.close();
		} catch {
			// best-effort
		}
		this.context = null;
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
