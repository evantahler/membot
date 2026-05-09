import { join } from "node:path";
import type { Command } from "commander";
import Mustache from "mustache";
import { FILES } from "../constants.ts";
import { buildContext, closeContext } from "../context.ts";
import { HelpfulError } from "../errors.ts";
import { BrowserPool } from "../ingest/downloaders/browser.ts";
import { collectLoginEntries } from "../ingest/downloaders/index.ts";
import { logger } from "../output/logger.ts";
import LOGIN_PAGE_TEMPLATE from "./login-page.mustache" with { type: "text" };

/**
 * `membot login`
 *
 * Open a real Chromium window backed by membot's persistent profile
 * (cookies + localStorage + IndexedDB + service workers all stored
 * under `~/.membot/auth/browser-profile/`) and pre-navigate to a
 * small intro page that lists every login button declared by the
 * registered downloaders. Adding a new downloader with `logins: […]`
 * automatically gets a button on this page — login.ts knows nothing
 * service-specific itself.
 *
 * Why a persistent profile instead of `storageState` JSON: SPA-heavy
 * services like Linear stash session/sync state in IndexedDB, which
 * `storageState` doesn't capture. A fresh headless context with
 * cookies but no IndexedDB hangs on Linear's "Loading…" placeholder
 * forever. The persistent profile carries IDB along with cookies, so
 * the next headless run finds Linear's app fully bootstrapped.
 *
 * Window-close detection uses page-close events because on macOS
 * closing the last chromium window doesn't quit the process —
 * `browser.on('disconnected')` never fires. See `BrowserPool.waitForUserDone`.
 */
export function registerLoginCommand(program: Command): void {
	program
		.command("login")
		.description(
			"Open a browser to sign into the services membot fetches from — closing the window saves your session.",
		)
		.action(async () => {
			const ctx = await buildContext({});
			const userDataDir = join(ctx.dataDir, FILES.BROWSER_PROFILE);
			const pool = new BrowserPool({ userDataDir, headless: false });
			const entries = collectLoginEntries();
			const html = Mustache.render(LOGIN_PAGE_TEMPLATE, {
				browser: entries.browser,
				apiKey: entries.apiKey,
				hasBrowser: entries.browser.length > 0,
				hasApiKey: entries.apiKey.length > 0,
			});

			let cookieCount = 0;
			try {
				const page = await pool.newPage();
				await page.goto(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch(() => {});

				logger.info("Sign into the services you want membot to fetch from, then close the browser window.");
				logger.info(`Session profile will be stored at ${userDataDir}.`);

				await pool.waitForUserDone(page);
				cookieCount = await pool.cookieCount();
			} catch (err) {
				if (err instanceof HelpfulError) throw err;
				throw new HelpfulError({
					kind: "internal_error",
					message: `login failed: ${err instanceof Error ? err.message : String(err)}`,
					hint: "Run `bunx playwright install chromium` to ensure the browser binary is installed, then retry.",
				});
			} finally {
				await pool.dispose();
				await closeContext(ctx);
			}

			if (cookieCount === 0) {
				throw new HelpfulError({
					kind: "auth_error",
					message: `Browser profile at ${userDataDir} has no cookies — no service was signed in.`,
					hint: "Run `membot login` again and sign in (Google / GitHub / Linear / …) before closing the window.",
				});
			}
			logger.info(`Saved session profile (${cookieCount} cookie${cookieCount === 1 ? "" : "s"}).`);
		});
}
