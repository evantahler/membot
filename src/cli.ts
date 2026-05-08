#!/usr/bin/env bun

import { bold, cyan, dim, green, yellow } from "ansis";
import { program } from "commander";
import pkg from "../package.json" with { type: "json" };
import { registerMcpxCommand } from "./commands/mcpx.ts";
import { registerReindexCommand } from "./commands/reindex.ts";
import { registerServeCommand } from "./commands/serve.ts";
import type { BuildContextOptions } from "./context.ts";
import { mountAsCommanderCommand } from "./mount/commander.ts";
import { OPERATIONS } from "./operations/index.ts";

program
	.name("membot")
	.description("Versioned context store with hybrid search for AI agents. Stdio + HTTP MCP server and CLI.")
	.version(pkg.version)
	.option("-c, --config <path>", "membot data dir (default ~/.membot)")
	.option("-j, --json", "force JSON output")
	.option("-v, --verbose", "verbose / debug logging")
	.option("--no-color", "disable ANSI colors")
	.option("--no-interactive", "force non-interactive mode (no spinners)");

program.configureHelp({
	styleTitle: (str) => bold(str),
	styleCommandText: (str) => cyan(str),
	styleSubcommandText: (str) => cyan(str),
	styleOptionText: (str) => yellow(str),
	styleArgumentText: (str) => green(str),
	styleDescriptionText: (str) => dim(str),
});

const getContextOptions = (): BuildContextOptions => {
	const opts = program.opts<{
		config?: string;
		json?: boolean;
		verbose?: boolean;
		color?: boolean;
		interactive?: boolean;
	}>();
	return {
		configFlag: opts.config,
		json: opts.json,
		verbose: opts.verbose,
		noColor: opts.color === false,
		noInteractive: opts.interactive === false,
	};
};

for (const op of OPERATIONS) {
	mountAsCommanderCommand(program, op, getContextOptions);
}

registerServeCommand(program);
registerReindexCommand(program);
registerMcpxCommand(program);

program.parse();
