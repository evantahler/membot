import type { CliToolLoginEntry } from "./types.ts";

const GOOGLE_LOGIN: CliToolLoginEntry = {
	kind: "cli_tool",
	name: "Google",
	setupCommand: "gws auth setup",
	description: "covers Docs, Sheets, and Slides via the bundled gws CLI",
};

/**
 * Shared login entry referenced by all three Google plugins; the
 * registry dedupes on `setupCommand`, so all three Google plugins
 * collapse to a single interactive `gws auth setup` step inside
 * `membot login`.
 */
export function googleLoginEntry(): CliToolLoginEntry {
	return GOOGLE_LOGIN;
}
