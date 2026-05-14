#!/usr/bin/env bun

import { bold, cyan, dim, green, yellow } from "ansis";
import { program } from "commander";
import pkg from "../package.json" with { type: "json" };
import { registerCheckUpdateCommand } from "./commands/check-update.ts";
import { registerConfigCommand } from "./commands/config.ts";
import { registerLoginCommand } from "./commands/login.ts";
import { registerLogsCommand } from "./commands/logs.ts";
import { registerReindexCommand } from "./commands/reindex.ts";
import { registerRouterCommand } from "./commands/router.ts";
import { registerServeCommand } from "./commands/serve.ts";
import { registerSkillCommand } from "./commands/skill.ts";
import { registerUpgradeCommand } from "./commands/upgrade.ts";
import { EMBED_WORKER_SENTINEL } from "./constants.ts";
import type { BuildContextOptions } from "./context.ts";
import { runEmbedWorker } from "./ingest/embed-worker.ts";
import { mountAsCommanderCommand } from "./mount/commander.ts";
import { OPERATIONS } from "./operations/index.ts";
import { logger } from "./output/logger.ts";
import { maybeCheckForUpdate } from "./update/background.ts";

// Hidden worker mode: the EmbedderPool re-execs this binary with the sentinel
// as argv[2] (or argv[1] when `bun run src/cli.ts <sentinel>` is invoked
// directly during tests). We bypass commander entirely and run the worker
// stdin/stdout protocol loop instead.
if (process.argv.includes(EMBED_WORKER_SENTINEL)) {
	await runEmbedWorker();
	process.exit(0);
}

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
registerRouterCommand(program);
registerLoginCommand(program);
registerLogsCommand(program);
registerSkillCommand(program);
registerCheckUpdateCommand(program);
registerUpgradeCommand(program);

const updateNotice = maybeCheckForUpdate();

program.parse();

process.on("beforeExit", async () => {
	const notice = await updateNotice;
	if (notice) logger.writeRaw(notice);
});
