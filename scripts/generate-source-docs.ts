#!/usr/bin/env bun
/**
 * Regenerate the auto-generated source-plugin sections in README.md,
 * `.claude/skills/membot.md`, and `.cursor/rules/membot.mdc`. Run via
 * `bun run docs:sources` after touching any plugin file; `bun run
 * docs:sources:check` exits non-zero on drift (used in CI).
 *
 * The marker pair is:
 *
 *   <!-- AUTO-GENERATED:sources -->
 *   …generated body…
 *   <!-- /AUTO-GENERATED:sources -->
 *
 * Anything outside the markers is left untouched. Each target file
 * controls its own surrounding prose; the codegen only owns what's
 * between the markers.
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// Populate the source-plugin registry via side-effect imports.
import "../src/ingest/sources/index.ts";
import { listSources } from "../src/ingest/sources/registry.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const OPEN = "<!-- AUTO-GENERATED:sources -->";
const CLOSE = "<!-- /AUTO-GENERATED:sources -->";

const TARGETS: string[] = [
	join(REPO_ROOT, "README.md"),
	join(REPO_ROOT, ".claude/skills/membot.md"),
	join(REPO_ROOT, ".cursor/rules/membot.mdc"),
];

/**
 * Compose the human-readable body that replaces whatever lives between
 * the markers. A markdown table is denser than the bulleted form
 * `renderSourceList()` produces, so we render it here directly off the
 * registry. Examples are joined with `<br>` since GitHub-flavored
 * markdown tables don't support newlines inside cells.
 */
function renderTable(): string {
	const lines: string[] = [];
	lines.push("");
	lines.push("| Plugin | Auth | Examples | Notes |");
	lines.push("| --- | --- | --- | --- |");
	for (const p of listSources()) {
		const auth = p.config
			? `\`api_key\` — \`${p.logins?.[0]?.kind === "api_key" ? p.logins[0].setupCommand : ""}\``
			: p.logins?.[0]?.kind === "cli_tool"
				? "cli_tool — `membot login`"
				: "none";
		const examples = p.examples.map((e) => `\`${e}\``).join("<br>");
		const notes = (p.notes ?? "").replace(/\n+/g, " ");
		const platform = p.platform ? ` _(${p.platform.join(", ")} only)_` : "";
		lines.push(`| **${p.name}**${platform}<br>${p.description} | ${auth} | ${examples} | ${notes} |`);
	}
	lines.push("");
	return lines.join("\n");
}

/**
 * Replace the OPEN…CLOSE block in `content` with `body`. Both markers
 * must already exist; this isn't a creator. The codegen is intentionally
 * unforgiving here so a misnamed marker fails loudly.
 */
function spliceBlock(content: string, body: string): string {
	const openIdx = content.indexOf(OPEN);
	const closeIdx = content.indexOf(CLOSE);
	if (openIdx === -1 || closeIdx === -1 || closeIdx < openIdx) {
		throw new Error(`marker pair "${OPEN}" / "${CLOSE}" not found or out of order`);
	}
	const before = content.slice(0, openIdx + OPEN.length);
	const after = content.slice(closeIdx);
	return `${before}\n${body}\n${after}`;
}

async function processFile(path: string, body: string, check: boolean): Promise<{ path: string; drift: boolean }> {
	const original = await readFile(path, "utf8");
	const updated = spliceBlock(original, body);
	if (original === updated) return { path, drift: false };
	if (check) return { path, drift: true };
	await writeFile(path, updated);
	return { path, drift: false };
}

async function main(): Promise<void> {
	const check = process.argv.includes("--check");
	const body = renderTable();
	const results = await Promise.all(TARGETS.map((p) => processFile(p, body, check)));
	const drifted = results.filter((r) => r.drift);
	if (check && drifted.length > 0) {
		console.error("Source-plugin docs are out of date:");
		for (const r of drifted) console.error(`  - ${r.path}`);
		console.error("Run `bun run docs:sources` to regenerate.");
		process.exit(1);
	}
	if (!check) {
		const updated = results.filter((_r, i) => results[i] && true);
		for (const r of updated) console.log(`updated ${r.path.replace(`${REPO_ROOT}/`, "")}`);
	}
}

await main();
