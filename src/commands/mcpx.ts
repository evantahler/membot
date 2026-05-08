import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import { logger } from "../output/logger.ts";

const require = createRequire(import.meta.url);

/**
 * Resolve the path to the bundled mcpx CLI entrypoint. We spawn it as a
 * child process rather than calling its functions directly so that the
 * upstream's argv parsing, output formatting, and config conventions stay
 * authoritative — `membot mcpx <subcmd>` behaves identically to the user
 * running `mcpx <subcmd>` themselves, just with our project's `--config`
 * resolution layered on top when applicable.
 */
const MCPX_CLI = fileURLToPath(import.meta.resolve("@evantahler/mcpx/cli"));

/**
 * Forward an argv slice to the bundled mcpx CLI. Inherits stdio so prompts
 * and pretty output flow through as if mcpx were called directly. Exits
 * the parent process with the child's status code on failure.
 */
export async function runMcpx(args: string[]): Promise<void> {
	const proc = Bun.spawn(["bun", MCPX_CLI, ...args], {
		stdout: "inherit",
		stderr: "inherit",
		stdin: "inherit",
	});
	const code = await proc.exited;
	if (code !== 0) process.exit(code);
}

/**
 * Pull the verbatim argv tokens that follow `mcpx` in `process.argv`. We
 * forward them unmodified so flags (`--help`, `-c`, etc.) reach the
 * upstream CLI exactly as the user typed them.
 */
function getRawMcpxArgs(): string[] {
	const idx = process.argv.indexOf("mcpx");
	return idx === -1 ? [] : process.argv.slice(idx + 1);
}

const PASSTHROUGH_SUBCOMMANDS: ReadonlyArray<[name: string, desc: string]> = [
	["servers", "List configured MCP server names"],
	["info", "Show server overview or schema for a specific tool"],
	["search", "Search tools by keyword and/or semantic similarity"],
	["exec", "Execute a tool call"],
	["add", "Add an MCP server"],
	["remove", "Remove an MCP server"],
	["ping", "Check connectivity to MCP servers"],
	["auth", "Authenticate with an HTTP MCP server"],
	["deauth", "Remove stored authentication for a server"],
	["resource", "List resources for a server, or read a specific resource"],
	["prompt", "List prompts for a server, or get a specific prompt"],
	["task", "Manage async tool tasks (list, get, result, cancel)"],
	["index", "Build the search index from all configured servers"],
];

/**
 * Register `membot mcpx <subcommand>` for every passthrough subcommand on
 * the upstream CLI. `--help` and unknown options are forwarded so users
 * always get authoritative mcpx help text.
 */
export function registerMcpxCommand(program: Command): void {
	const mcpx = program.command("mcpx").description("Forward to the bundled mcpx CLI for managing MCP servers");

	const verifyVersion = (() => {
		try {
			const ourPkg = require("../../package.json") as { dependencies: Record<string, string> };
			const mcpxPkg = require("@evantahler/mcpx/package.json") as { version: string };
			const declared = ourPkg.dependencies["@evantahler/mcpx"];
			if (!declared) return true;
			return (
				mcpxPkg.version === declared ||
				declared.startsWith(mcpxPkg.version) ||
				mcpxPkg.version.startsWith(declared.replace(/^[\^~]/, ""))
			);
		} catch {
			return true;
		}
	})();
	if (!verifyVersion) {
		logger.warn("@evantahler/mcpx version mismatch — `membot mcpx` may behave unexpectedly.");
	}

	for (const [name, description] of PASSTHROUGH_SUBCOMMANDS) {
		mcpx
			.command(name)
			.description(description)
			.allowUnknownOption(true)
			.helpOption(false)
			.argument("[args...]", "arguments forwarded to mcpx")
			.action(async () => {
				await runMcpx(getRawMcpxArgs());
			});
	}

	// Upstream mcpx's "list" is the default action when invoked with no
	// subcommand — not a registered subcommand — so strip the "list" token
	// before forwarding.
	mcpx
		.command("list")
		.description("List all tools, resources, and prompts across all configured servers")
		.allowUnknownOption(true)
		.helpOption(false)
		.argument("[args...]", "arguments forwarded to mcpx")
		.action(async () => {
			const raw = getRawMcpxArgs();
			const args = raw[0] === "list" ? raw.slice(1) : raw;
			await runMcpx(args);
		});
}
