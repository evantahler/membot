#!/usr/bin/env bun

import { bold, cyan, dim, green, yellow } from "ansis";
import { program } from "commander";
import pkg from "../package.json" with { type: "json" };
import { registerCheckUpdateCommand } from "./commands/check-update.ts";
import { registerConfigCommand } from "./commands/config.ts";
import { registerLoginCommand } from "./commands/login.ts";
import { registerReindexCommand } from "./commands/reindex.ts";
import { registerServeCommand } from "./commands/serve.ts";
import { registerSkillCommand } from "./commands/skill.ts";
import { registerUpgradeCommand } from "./commands/upgrade.ts";
import type { BuildContextOptions } from "./context.ts";
import { mountAsCommanderCommand } from "./mount/commander.ts";
import { OPERATIONS } from "./operations/index.ts";
import { logger } from "./output/logger.ts";
import { maybeCheckForUpdate } from "./update/background.ts";

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
registerConfigCommand(program);
registerLoginCommand(program);
registerSkillCommand(program);
registerCheckUpdateCommand(program);
registerUpgradeCommand(program);

const updateNotice = maybeCheckForUpdate();

program.parse();

process.on("beforeExit", async () => {
	const notice = await updateNotice;
	if (notice) logger.writeRaw(notice);
});
