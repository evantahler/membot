import { cyan, dim, green, yellow } from "ansis";
import type { Command } from "commander";
import { createSpinner } from "nanospinner";
import { getUpdater } from "../update/updater.ts";

/**
 * Register `membot check-update`. Performs a non-destructive npm-registry check
 * (via `upgradr`), and prints the current/latest version (plus changelog when an
 * update is available). Emits the raw `upgradr` check result as JSON when `--json`
 * is set. The check itself is cached by `upgradr` under `~/.membot/update.json`.
 */
export function registerCheckUpdateCommand(program: Command) {
	program
		.command("check-update")
		.description("Check for a newer version of membot")
		.action(async () => {
			const opts = program.opts();
			const json = !!(opts.json as boolean | undefined);
			const isTTY = process.stderr.isTTY ?? false;

			const spinner =
				!json && isTTY ? createSpinner("Checking for updates...", { stream: process.stderr }).start() : null;

			try {
				const info = await getUpdater().checkForUpdate();

				spinner?.stop();

				if (json) {
					console.log(JSON.stringify(info, null, 2));
					return;
				}

				if (!info.hasUpdate) {
					if (info.aheadOfLatest) {
						console.log(
							yellow(`membot v${info.currentVersion} is ahead of latest published release (v${info.latestVersion})`),
						);
					} else {
						console.log(green(`membot is up to date (v${info.currentVersion})`));
					}
					return;
				}

				console.log(yellow(`Update available: ${info.currentVersion} → ${info.latestVersion}`));

				if (info.changelog) {
					console.log("");
					console.log(dim(info.changelog));
				}

				console.log("");
				console.log(cyan("Run `membot upgrade` to update"));
			} catch (err) {
				spinner?.error({ text: "Failed to check for updates" });
				console.error(String(err));
				process.exit(1);
			}
		});
}
