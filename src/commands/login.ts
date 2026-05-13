import { bold, cyan, green } from "ansis";
import type { Command } from "commander";
import { buildContext, closeContext } from "../context.ts";
import { HelpfulError } from "../errors.ts";
import "../ingest/sources/index.ts"; // populate registry via side-effect imports
import { resolveGwsBinary } from "../ingest/gws.ts";
import { collectLoginEntries } from "../ingest/sources/registry.ts";
import { logger } from "../output/logger.ts";

/**
 * `membot login`
 *
 * Drive the one-time interactive authentication setup for every
 * downloader that declared a `LoginEntry`. There are two kinds:
 *
 *  - `cli_tool` (Google): runs the entry's `setupCommand` as an
 *    interactive subprocess (inherited stdio). For Google that's
 *    `gws auth setup`, which itself launches the user's default
 *    browser to a Google consent screen. Tokens land in the bundled
 *    CLI's own config (gws → `~/.config/gws/`); membot doesn't see
 *    or store them.
 *
 *  - `api_key` (GitHub, Linear): printed as instructions — the user
 *    creates the key on the service's settings page and copies the
 *    `membot config set ...` command into a terminal. Inherently
 *    non-interactive on membot's side.
 *
 * After this command, every `membot add` and `membot refresh` is
 * non-interactive — no browser windows, no prompts.
 */
export function registerLoginCommand(program: Command): void {
	program
		.command("login")
		.description(
			"Run the one-time interactive auth setup for every configured source (Google via gws; API-key services via instructions).",
		)
		.action(async () => {
			const ctx = await buildContext({});
			try {
				const entries = collectLoginEntries();

				if (entries.cliTool.length === 0 && entries.apiKey.length === 0) {
					logger.info("No source plugins require authentication on this install.");
					return;
				}

				for (const entry of entries.cliTool) {
					await runCliToolLogin(entry);
				}

				if (entries.apiKey.length > 0) {
					logger.info(bold("\nAPI-key services — set these manually:"));
					for (const entry of entries.apiKey) {
						const desc = entry.description ? ` (${entry.description})` : "";
						logger.info(`  • ${bold(entry.name)}${desc}`);
						logger.info(`      Create a key at: ${entry.url}`);
						logger.info(`      Then run: ${cyan(entry.setupCommand)}`);
					}
				}
			} finally {
				await closeContext(ctx);
			}
		});
}

async function runCliToolLogin(entry: { name: string; setupCommand: string; description?: string }): Promise<void> {
	const parts = entry.setupCommand.split(/\s+/).filter(Boolean);
	const [program, ...args] = parts;
	if (!program) {
		throw new HelpfulError({
			kind: "internal_error",
			message: `login entry "${entry.name}" declared an empty setupCommand`,
			hint: "Open the plugin's LoginEntry declaration and set a non-empty setupCommand.",
		});
	}

	// For `gws`, route the call through the bundled binary path rather
	// than relying on the user's PATH — the postinstall script puts it at
	// `~/.membot/bin/gws`, which probably isn't on PATH.
	let resolved = program;
	if (program === "gws") {
		const bundled = resolveGwsBinary();
		if (!bundled) {
			throw new HelpfulError({
				kind: "internal_error",
				message: `gws binary not found — required to authenticate ${entry.name}`,
				hint: "Reinstall membot (`bun add -g membot`) to re-run the postinstall, or set MEMBOT_GWS_PATH to a manually-installed gws binary.",
			});
		}
		resolved = bundled;
	}

	logger.info(bold(`\nSigning into ${entry.name}…`));
	if (entry.description) logger.info(`  ${entry.description}`);
	logger.info(`  running: ${cyan([program, ...args].join(" "))}`);

	const proc = Bun.spawn([resolved, ...args], { stdout: "inherit", stderr: "inherit", stdin: "inherit" });
	const code = await proc.exited;
	if (code !== 0) {
		throw new HelpfulError({
			kind: "auth_error",
			message: `${entry.setupCommand} exited with code ${code}`,
			hint: `Re-run \`membot login\`, or invoke \`${entry.setupCommand}\` directly to inspect the failure.`,
		});
	}
	logger.info(green(`✓ ${entry.name} sign-in complete.`));
}
