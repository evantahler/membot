import { bold, cyan } from "ansis";
import type { Command } from "commander";
import { buildContext, closeContext } from "../context.ts";
import "../ingest/sources/index.ts"; // populate registry via side-effect imports
import { collectLoginEntries } from "../ingest/sources/registry.ts";
import { logger } from "../output/logger.ts";

/**
 * `membot login`
 *
 * Print one-time auth setup instructions for every source that
 * declared an `api_key` `LoginEntry`. Today that's GitHub and Linear;
 * the user creates a token on the service's settings page and copies
 * the `membot config set ...` command into their terminal.
 *
 * Membot itself never opens a browser, prompts for credentials, or
 * stores tokens — all auth state lives in `~/.membot/config.json`
 * (api_key services) and is set explicitly by the user.
 */
export function registerLoginCommand(program: Command): void {
	program
		.command("login")
		.description("Print one-time auth setup instructions for every configured source.")
		.action(async () => {
			const ctx = await buildContext({});
			try {
				const entries = collectLoginEntries();

				if (entries.apiKey.length === 0) {
					logger.info("No source plugins require authentication on this install.");
					return;
				}

				logger.info(bold("API-key services — set these manually:"));
				for (const entry of entries.apiKey) {
					const desc = entry.description ? ` (${entry.description})` : "";
					logger.info(`  • ${bold(entry.name)}${desc}`);
					logger.info(`      Create a key at: ${entry.url}`);
					logger.info(`      Then run: ${cyan(entry.setupCommand)}`);
				}
			} finally {
				await closeContext(ctx);
			}
		});
}
