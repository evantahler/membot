import { join } from "node:path";
import { defaultMembotHome } from "../constants.ts";
import type { UpdateCache } from "./checker.ts";

/** Path to the JSON file that holds the latest update-check result. */
function updateCachePath(): string {
	return join(defaultMembotHome(), "update.json");
}

/** Load the cached update-check result, or `undefined` if missing/unreadable. */
export async function loadUpdateCache(): Promise<UpdateCache | undefined> {
	try {
		const file = Bun.file(updateCachePath());
		if (!(await file.exists())) return undefined;
		return JSON.parse(await file.text()) as UpdateCache;
	} catch {
		return undefined;
	}
}

/** Persist a fresh update-check result. Silent on write failure (e.g. permission denied). */
export async function saveUpdateCache(cache: UpdateCache): Promise<void> {
	try {
		await Bun.write(updateCachePath(), `${JSON.stringify(cache, null, 2)}\n`);
	} catch {
		// Ignore write failures (e.g. permissions)
	}
}

/** Empty the cache file so the next check is forced to refetch. */
export async function clearUpdateCache(): Promise<void> {
	try {
		const file = Bun.file(updateCachePath());
		if (await file.exists()) {
			await Bun.write(updateCachePath(), "");
		}
	} catch {
		// Ignore
	}
}
