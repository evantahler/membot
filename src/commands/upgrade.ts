import { green, red, yellow } from "ansis";
import type { Command } from "commander";
import { createSpinner } from "nanospinner";
import { getUpdater } from "../update/updater.ts";

/**
 * Register `membot upgrade`. Delegates to `upgradr`, which re-checks npm for the
 * latest version, detects the install method (npm/bun/binary/local-dev), and
 * performs the appropriate self-update. This command owns all presentation;
 * `upgradr` never writes to the console or exits the process. Emits the raw
 * `upgradr` upgrade result as JSON when `--json` is set.
 */
export function registerUpgradeCommand(program: Command) {
	program
		.command("upgrade")
		.description("Upgrade membot to the latest version")
		.action(async () => {
			const opts = program.opts();
			const json = !!(opts.json as boolean | undefined);
			const isTTY = process.stderr.isTTY ?? false;

			const spinner =
				!json && isTTY ? createSpinner("Checking for updates...", { stream: process.stderr }).start() : null;

			try {
				const result = await getUpdater().upgrade();

				spinner?.stop();

				// A real failure is an attempted-but-failed install; being up to date
				// or running from source (local-dev, success:false) is not a failure.
				const failed = result.hasUpdate && result.method !== "local-dev" && !result.success;

				if (json) {
					console.log(JSON.stringify(result, null, 2));
					if (failed) process.exit(1);
					return;
				}

				// Already on the latest version — no install attempted.
				if (!result.hasUpdate) {
					console.log(green(`membot is already up to date (v${result.from})`));
					return;
				}

				// Source checkout: upgrading is the user's job (git pull), not ours.
				if (result.method === "local-dev") {
					console.log(yellow("Running from source. Use `git pull && bun install` to update."));
					return;
				}

				if (result.success) {
					console.log(green(`Successfully upgraded membot: v${result.from} → v${result.to} (${result.method})`));
					return;
				}

				console.error(red(`Upgrade failed: ${result.error ?? "unknown error"}`));
				process.exit(1);
			} catch (err) {
				spinner?.error({ text: "Upgrade failed" });
				console.error(String(err));
				process.exit(1);
			}
		});
}
