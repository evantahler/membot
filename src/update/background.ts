import { cyan, dim, yellow } from "ansis";
import pkg from "../../package.json" with { type: "json" };
import { DEFAULTS, ENV } from "../constants.ts";
import { loadUpdateCache, saveUpdateCache } from "./cache.ts";
import { checkForUpdate, needsCheck, type UpdateCache } from "./checker.ts";

/** Format a multi-line stderr update notice (yellow header + dim changelog + cyan call-to-action). */
function formatNotice(currentVersion: string, latestVersion: string, changelog?: string): string {
	const lines: string[] = ["", yellow(`Update available: ${currentVersion} → ${latestVersion}`)];

	if (changelog) {
		lines.push("");
		lines.push(dim(changelog));
	}

	lines.push("");
	lines.push(cyan("Run `membot upgrade` to update"));
	lines.push("");

	return lines.join("\n");
}

/**
 * Non-blocking background update check. Returns a formatted notice string when
 * an update is available, or `null` otherwise. Honors `MEMBOT_NO_UPDATE_CHECK`,
 * skips itself for the upgrade/check-update commands, and only fires in TTY.
 * Never throws.
 */
export async function maybeCheckForUpdate(): Promise<string | null> {
	try {
		if (process.env[ENV.NO_UPDATE_CHECK] === "1") return null;

		const args = process.argv.slice(2);
		const command = args.find((a) => !a.startsWith("-"));
		if (command === "check-update" || command === "upgrade") return null;

		if (!(process.stderr.isTTY ?? false)) return null;

		const cache = await loadUpdateCache();

		if (!needsCheck(cache)) {
			if (cache?.hasUpdate) {
				return formatNotice(pkg.version, cache.latestVersion, cache.changelog);
			}
			return null;
		}

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), DEFAULTS.UPDATE_CHECK_TIMEOUT_MS);

		try {
			const info = await checkForUpdate(pkg.version, controller.signal);

			const newCache: UpdateCache = {
				lastCheckAt: new Date().toISOString(),
				latestVersion: info.latestVersion,
				hasUpdate: info.hasUpdate,
				changelog: info.changelog,
			};
			await saveUpdateCache(newCache);

			if (info.hasUpdate) {
				return formatNotice(pkg.version, info.latestVersion, info.changelog);
			}
		} finally {
			clearTimeout(timeout);
		}

		return null;
	} catch {
		return null;
	}
}
