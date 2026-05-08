import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Command } from "commander";
import claudeSkill from "../../.claude/skills/membot.md" with { type: "text" };
import cursorRule from "../../.cursor/rules/membot.mdc" with { type: "text" };
import { HelpfulError, isHelpfulError, mapKindToExit } from "../errors.ts";
import { renderCliError } from "../mount/commander.ts";
import { logger } from "../output/logger.ts";
import { detectMode, setMode } from "../output/tty.ts";

interface SkillTarget {
	agentLabel: string;
	scopeLabel: string;
	dir: string;
	filename: string;
	content: string;
}

interface SkillInstallOptions {
	claude?: boolean;
	cursor?: boolean;
	global?: boolean;
	project?: boolean;
	force?: boolean;
}

/**
 * `membot skill install [--claude] [--cursor] [--global|--project] [-f]`
 *
 * Drop the membot agent skill into the right location for Claude Code
 * (`.claude/skills/membot.md`) or Cursor (`.cursor/rules/membot.mdc`),
 * either in the current project (default) or in the user's home directory
 * (`--global`). Both flags can be combined to install for both targets at
 * once. The skill files are bundled into the binary via Bun text imports
 * so this works in the compiled distribution as well as in `bun run`.
 */
export function registerSkillCommand(program: Command): void {
	const skill = program.command("skill").description("Install agent skills (Claude Code, Cursor)");

	skill
		.command("install")
		.description(
			"Install the membot skill into Claude Code (.claude/skills/membot.md) and/or Cursor (.cursor/rules/membot.mdc)",
		)
		.option("--claude", "install for Claude Code")
		.option("--cursor", "install for Cursor")
		.option("--global", "install to the user's home directory (default: project)")
		.option("--project", "install to the current working directory (default)")
		.option("-f, --force", "overwrite if the skill file already exists")
		.action((opts: SkillInstallOptions) => {
			const globalOpts = program.optsWithGlobals<{ json?: boolean; verbose?: boolean; color?: boolean }>();
			setMode(
				detectMode({
					json: globalOpts.json,
					verbose: globalOpts.verbose,
					noColor: globalOpts.color === false,
				}),
			);
			try {
				install(opts);
			} catch (err) {
				renderCliError(err);
				process.exit(isHelpfulError(err) ? mapKindToExit(err.kind) : 1);
			}
		});
}

/**
 * Resolve and write every requested skill file. Throws `HelpfulError` on
 * any input or conflict failure so the mount-style error renderer can
 * surface a uniform JSON / colorized message.
 */
function install(opts: SkillInstallOptions): void {
	if (!opts.claude && !opts.cursor) {
		throw new HelpfulError({
			kind: "input_error",
			message: "no agent target specified",
			hint: "Pass --claude, --cursor, or both — e.g. `membot skill install --claude`",
		});
	}

	const targets = computeTargets(opts);
	for (const target of targets) {
		const dest = join(target.dir, target.filename);
		if (existsSync(dest) && !opts.force) {
			throw new HelpfulError({
				kind: "conflict",
				message: `${dest} already exists`,
				hint: "Re-run with --force to overwrite",
			});
		}
		mkdirSync(target.dir, { recursive: true });
		writeFileSync(dest, target.content, "utf-8");
		logger.info(`installed ${target.agentLabel} skill (${target.scopeLabel}): ${dest}`);
	}
}

/**
 * Materialise the (agent × scope) cartesian product of install targets the
 * user asked for. Default scope is project when neither --global nor
 * --project is passed; passing both installs to both locations.
 */
function computeTargets(opts: SkillInstallOptions): SkillTarget[] {
	const scopes: { label: string; resolveDir: (rel: string) => string }[] = [];
	if (opts.global) scopes.push({ label: "global", resolveDir: (rel) => join(homedir(), rel) });
	if (opts.project || !opts.global) scopes.push({ label: "project", resolveDir: (rel) => resolve(rel) });

	const targets: SkillTarget[] = [];
	for (const scope of scopes) {
		if (opts.claude) {
			targets.push({
				agentLabel: "Claude Code",
				scopeLabel: scope.label,
				dir: scope.resolveDir(".claude/skills"),
				filename: "membot.md",
				content: claudeSkill,
			});
		}
		if (opts.cursor) {
			targets.push({
				agentLabel: "Cursor",
				scopeLabel: scope.label,
				dir: scope.resolveDir(".cursor/rules"),
				filename: "membot.mdc",
				content: cursorRule,
			});
		}
	}
	return targets;
}
