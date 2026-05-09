import { join } from "node:path";
import type { Command } from "commander";
import { FILES } from "../constants.ts";
import { buildContext, closeContext } from "../context.ts";
import { HelpfulError } from "../errors.ts";
import { BrowserPool } from "../ingest/downloaders/browser.ts";
import { logger } from "../output/logger.ts";

/**
 * `membot login`
 *
 * Open a real Chromium window with whatever cookies we already have.
 * The user navigates to whichever services they plan to ingest from
 * (Google, GitHub, Linear, anything else), signs in, and closes the
 * browser. We then persist the resulting `storageState` to
 * `~/.membot/auth/browser.json` so every downloader can replay those
 * cookies on subsequent runs.
 */
export function registerLoginCommand(program: Command): void {
	program
		.command("login")
		.description("Open a browser to sign into services (Google, GitHub, Linear, …) — closes save your session.")
		.action(async () => {
			const ctx = await buildContext({});
			const storagePath = join(ctx.dataDir, FILES.BROWSER_STATE);
			const pool = new BrowserPool({ storageStatePath: storagePath, headless: false });
			try {
				const page = await pool.newPage();
				await page.goto("about:blank").catch(() => {});
				logger.info(
					"Sign into the services you want membot to ingest from (Google Docs, GitHub, Linear, …), then close the browser window.",
				);
				logger.info(`Session will be saved to ${storagePath}.`);
				await waitForBrowserClose(pool);
				await pool.persistStorageState();
				logger.info(`Saved session to ${storagePath}.`);
			} catch (err) {
				if (err instanceof HelpfulError) throw err;
				throw new HelpfulError({
					kind: "internal_error",
					message: `login failed: ${err instanceof Error ? err.message : String(err)}`,
					hint: "Run `npx playwright install chromium` to ensure the browser binary is installed, then retry.",
				});
			} finally {
				await pool.dispose();
				await closeContext(ctx);
			}
		});
}

/**
 * Resolve when the user closes the browser. The pool's internal
 * `_browser` isn't directly exposed for ergonomic reasons, so we
 * race a no-op page that polls until any browser-level disconnect
 * happens. Implementation: open one extra page, listen for the
 * `close` event on the parent context.
 */
async function waitForBrowserClose(pool: BrowserPool): Promise<void> {
	// Re-fetch the request context to ensure the browser/context exists,
	// then attach a `close` listener via a small polling loop on a sentinel
	// page. Playwright's BrowserContext emits 'close' when the user closes
	// every page or the browser itself.
	const sentinel = await pool.newPage();
	await new Promise<void>((resolve) => {
		const finish = () => resolve();
		sentinel.on("close", finish);
		sentinel.context().on("close", finish);
		sentinel.context().browser()?.on("disconnected", finish);
	});
}
