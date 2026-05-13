import type { Command } from "commander";
import { loadConfig, saveConfig } from "../config/loader.ts";
import {
	BUILTIN_POST_PROCESSORS,
	type BuiltinPostProcessor,
	compileRouterPattern,
	getCustomRouters,
	type PostProcessSpec,
	type Router,
	RouterSchema,
	validateRouters,
	withCustomRouters,
} from "../config/router-validation.ts";
import { MembotConfigSchema } from "../config/schemas.ts";
import { HelpfulError, isHelpfulError, mapKindToExit } from "../errors.ts";
import { listCurrent } from "../db/files.ts";
import { buildContext, closeContext } from "../context.ts";
import { applyPostProcessor } from "../ingest/sources/post-processors.ts";
import { renderCliError } from "../mount/commander.ts";
import { colors, renderTable } from "../output/formatter.ts";
import { logger } from "../output/logger.ts";
import { detectMode, isJson, setMode } from "../output/tty.ts";

interface AddOptions {
	name?: string;
	urlPattern?: string;
	command?: string;
	args?: string;
	mimeType?: string;
	postProcess?: string;
	postProcessCommand?: string;
	postProcessArgs?: string;
	postProcessTimeoutMs?: string;
	timeoutMs?: string;
	stdin?: string;
	force?: boolean;
}

interface TestOptions {
	exec?: boolean;
}

/**
 * `membot router {add,list,remove,test}`
 *
 * Manage user-defined URL routers that dispatch matched URLs to external
 * shell commands. Routers live under `downloaders.custom_routers` in
 * `~/.membot/config.json`; the on-disk shape is the single source of
 * truth, so editing the JSON file by hand works fine — these commands
 * are convenience wrappers with validation.
 *
 * Example (Google Docs via mcpx):
 *
 *   membot router add \
 *     --name google-docs \
 *     --url-pattern '^https://docs\.google\.com/document/d/(?<doc_id>[a-zA-Z0-9_-]+)' \
 *     --command mcpx \
 *     --args 'exec,GoogleDocs_GetDocumentAsDocmd,--doc-id,{doc_id}' \
 *     --mime-type text/markdown \
 *     --post-process docmd
 */
export function registerRouterCommand(program: Command): void {
	const router = program.command("router").description("Manage user-defined URL routers (downloaders.custom_routers)");

	router
		.command("add")
		.description("Add (or replace) a custom URL router")
		.option("--name <name>", "router id (unique within the array)")
		.option("--url-pattern <regex>", "JS regex with (?<name>...) groups for ID extraction")
		.option("--command <cmd>", "executable to invoke")
		.option(
			"--args <csv>",
			"comma-separated argv elements; {var} substitutes from named groups, {url} substitutes the full URL",
		)
		.option("--mime-type <mime>", "mime type of the command's stdout (default text/markdown)")
		.option(
			"--post-process <name>",
			`built-in post-processor: ${BUILTIN_POST_PROCESSORS.join(" | ")} (default passthrough)`,
		)
		.option(
			"--post-process-command <cmd>",
			"shell-command flavor of post-processor: this command receives the fetched bytes on stdin",
		)
		.option("--post-process-args <csv>", "comma-separated args for --post-process-command")
		.option("--post-process-timeout-ms <n>", "timeout for --post-process-command")
		.option("--timeout-ms <n>", "primary command timeout in ms (default 60000)")
		.option("--stdin <text>", "string to feed on the primary command's stdin (supports {var} / {url})")
		.option("-f, --force", "replace an existing router with the same name")
		.action((opts: AddOptions) => runSubcommand(program, async () => runAdd(opts)));

	router
		.command("list")
		.description("List configured custom URL routers")
		.action(() => runSubcommand(program, async () => runList()));

	router
		.command("remove")
		.argument("<name>", "router name")
		.description("Remove a custom URL router by name")
		.action((name: string) => runSubcommand(program, async () => runRemove(name)));

	router
		.command("test")
		.argument("<url>", "URL to dispatch")
		.option("--exec", "also run the matched router's command and print its stdout")
		.description("Show which router (if any) claims a URL and what variables it would extract")
		.action((url: string, opts: TestOptions) => runSubcommand(program, async () => runTest(url, opts)));
}

async function runSubcommand(program: Command, fn: () => Promise<void>): Promise<void> {
	const globalOpts = program.optsWithGlobals<{ json?: boolean; verbose?: boolean; color?: boolean }>();
	setMode(
		detectMode({
			json: globalOpts.json,
			verbose: globalOpts.verbose,
			noColor: globalOpts.color === false,
		}),
	);
	try {
		await fn();
	} catch (err) {
		renderCliError(err);
		process.exit(isHelpfulError(err) ? mapKindToExit(err.kind) : 1);
	}
}

async function runAdd(opts: AddOptions): Promise<void> {
	const router = buildRouterFromFlags(opts);

	const { config, configPath } = await loadConfig();
	const existing = getCustomRouters(config);
	const sameName = existing.findIndex((r) => r.name === router.name);
	if (sameName >= 0 && !opts.force) {
		throw new HelpfulError({
			kind: "conflict",
			message: `router "${router.name}" already exists`,
			hint: `Pass --force to replace it, or pick a different --name. Run \`membot router list\` to see existing routers.`,
		});
	}

	const next = existing.slice();
	if (sameName >= 0) next[sameName] = router;
	else next.push(router);
	validateRouters(next);

	const draft = applyRouters(config, next);
	// Re-parse the entire config to surface any cross-field issues (e.g.
	// duplicate names slipped past the array-level check above) through
	// the same error path the loader uses.
	const validated = MembotConfigSchema.parse(draft);
	await saveConfig(configPath, validated);

	if (isJson()) {
		process.stdout.write(`${JSON.stringify({ ok: true, action: sameName >= 0 ? "replaced" : "added", router })}\n`);
	} else {
		logger.info(`${sameName >= 0 ? "replaced" : "added"} router ${colors.cyan(router.name)}`);
		logger.info(`  pattern: ${router.url_pattern}`);
		logger.info(`  command: ${router.command} ${router.args.join(" ")}`);
		logger.info(`  post_process: ${describePostProcess(router.post_process)}`);
	}
}

async function runList(): Promise<void> {
	const { config } = await loadConfig();
	const routers = getCustomRouters(config);

	if (isJson()) {
		process.stdout.write(`${JSON.stringify(routers, null, 2)}\n`);
		return;
	}

	if (routers.length === 0) {
		logger.info("no custom routers configured. Run `membot router add --help` for an example.");
		return;
	}

	const rows = routers.map((r) => [
		colors.cyan(r.name),
		r.url_pattern,
		`${r.command} ${r.args.join(" ")}`.trim(),
		r.mime_type,
		describePostProcess(r.post_process),
	]);
	process.stdout.write(`${renderTable(["name", "url_pattern", "command", "mime_type", "post_process"], rows)}\n`);
}

async function runRemove(name: string): Promise<void> {
	const { config, configPath } = await loadConfig();
	const existing = getCustomRouters(config);
	const idx = existing.findIndex((r) => r.name === name);
	if (idx < 0) {
		throw new HelpfulError({
			kind: "not_found",
			message: `no router named "${name}"`,
			hint: "Run `membot router list` to see configured routers.",
		});
	}

	const next = existing.slice();
	next.splice(idx, 1);
	const draft = applyRouters(config, next);
	const validated = MembotConfigSchema.parse(draft);
	await saveConfig(configPath, validated);

	const usingRouter = await countRowsUsingRouter(name);
	if (usingRouter > 0) {
		logger.warn(
			`removed router "${name}", but ${usingRouter} stored row(s) still reference it. Those rows will fail to refresh until you re-add the router (or remove the rows with \`membot remove <path>\`).`,
		);
	}

	if (isJson()) {
		process.stdout.write(`${JSON.stringify({ ok: true, removed: name, rows_orphaned: usingRouter })}\n`);
	} else {
		logger.info(`removed router ${colors.cyan(name)}`);
	}
}

async function runTest(url: string, opts: TestOptions): Promise<void> {
	const { config } = await loadConfig();
	const routers = getCustomRouters(config);

	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch (err) {
		throw new HelpfulError({
			kind: "input_error",
			message: `not a valid URL: ${url}`,
			cause: err,
			hint: "Pass an http(s):// URL — `membot router test` dispatches only URLs, not scheme sources or local paths.",
		});
	}

	let matched: { router: Router; vars: Record<string, string> } | null = null;
	for (const router of routers) {
		const re = compileRouterPattern(router);
		const match = re.exec(parsed.toString());
		if (!match) continue;
		const vars: Record<string, string> = {};
		for (const [key, value] of Object.entries(match.groups ?? {})) {
			if (typeof value === "string") vars[key] = value;
		}
		matched = { router, vars };
		break;
	}

	if (!matched) {
		if (isJson()) {
			process.stdout.write(`${JSON.stringify({ matched: null, url })}\n`);
		} else {
			logger.info("no custom router matches this URL.");
		}
		return;
	}

	const { router, vars } = matched;
	if (!opts.exec) {
		if (isJson()) {
			process.stdout.write(`${JSON.stringify({ matched: router.name, vars, url })}\n`);
		} else {
			logger.info(`matched: ${colors.cyan(router.name)}`);
			logger.info(`vars: ${JSON.stringify(vars)}`);
			logger.info(`would run: ${router.command} ${interpolateForDisplay(router.args, vars, parsed.toString())}`);
		}
		return;
	}

	// --exec: actually run the spawn + post-process and emit stdout.
	// We re-import the plugin's runner via the post-processor path; for
	// the primary fetch we inline a small spawn here so this command
	// stays self-contained and doesn't require building a full plugin
	// PluginCtx (which would need a real AppContext we don't otherwise need).
	logger.info(`running ${router.command}...`);
	const primary = await spawnPrimary(router, vars, parsed.toString());
	logger.info(`post-processing (${describePostProcess(router.post_process)})...`);
	const final = await applyPostProcessor(router.post_process, primary, vars, parsed.toString());
	if (isJson()) {
		process.stdout.write(
			`${JSON.stringify({
				matched: router.name,
				vars,
				url,
				mime_type: router.mime_type,
				size_bytes: final.byteLength,
				stdout_utf8: new TextDecoder().decode(final),
			})}\n`,
		);
	} else {
		logger.info(`mime_type: ${router.mime_type}, ${final.byteLength} bytes`);
		process.stdout.write(new TextDecoder().decode(final));
		if (!new TextDecoder().decode(final).endsWith("\n")) process.stdout.write("\n");
	}
}

function buildRouterFromFlags(opts: AddOptions): Router {
	requireFlag(opts.name, "--name");
	requireFlag(opts.urlPattern, "--url-pattern");
	requireFlag(opts.command, "--command");

	const postProcess = buildPostProcess(opts);
	const draft = {
		name: opts.name as string,
		url_pattern: opts.urlPattern as string,
		command: opts.command as string,
		args: splitCsv(opts.args ?? ""),
		mime_type: opts.mimeType ?? "text/markdown",
		post_process: postProcess,
		timeout_ms: opts.timeoutMs ? parsePositiveInt(opts.timeoutMs, "--timeout-ms") : 60_000,
		stdin: opts.stdin ?? null,
	};

	const parsed = RouterSchema.safeParse(draft);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		const path = issue?.path.join(".") ?? "(root)";
		throw new HelpfulError({
			kind: "input_error",
			message: `invalid router definition (${path}): ${issue?.message ?? "unknown"}`,
			hint: "Run `membot router add --help` to see the supported flags and an example. The pattern is parsed as a JS RegExp; named groups (?<name>...) become substitution variables.",
		});
	}
	return parsed.data;
}

function buildPostProcess(opts: AddOptions): PostProcessSpec {
	const hasShell = !!opts.postProcessCommand;
	const hasName = !!opts.postProcess;

	if (hasShell && hasName) {
		throw new HelpfulError({
			kind: "input_error",
			message: "pass either --post-process or --post-process-command, not both",
			hint: "Built-in transforms (passthrough/docmd/html-to-markdown) use --post-process; an external shell command uses --post-process-command (+ --post-process-args).",
		});
	}

	if (hasShell) {
		return {
			command: opts.postProcessCommand as string,
			args: splitCsv(opts.postProcessArgs ?? ""),
			timeout_ms: opts.postProcessTimeoutMs ? parsePositiveInt(opts.postProcessTimeoutMs, "--post-process-timeout-ms") : 60_000,
		};
	}

	if (!hasName) return "passthrough";
	const candidate = opts.postProcess as string;
	if (!BUILTIN_POST_PROCESSORS.includes(candidate as BuiltinPostProcessor)) {
		throw new HelpfulError({
			kind: "input_error",
			message: `unknown --post-process: ${candidate}`,
			hint: `Pick one of: ${BUILTIN_POST_PROCESSORS.join(", ")}, or pass --post-process-command for a shell-command post-processor.`,
		});
	}
	return candidate as BuiltinPostProcessor;
}

function describePostProcess(spec: PostProcessSpec): string {
	if (typeof spec === "string") return spec;
	return `${spec.command} ${spec.args.join(" ")}`.trim();
}

const applyRouters = withCustomRouters;

async function countRowsUsingRouter(name: string): Promise<number> {
	const ctx = await buildContext({});
	try {
		const rows = await listCurrent(ctx.db, {});
		return rows.filter(
			(r) =>
				r.downloader === "custom-command" &&
				(r.downloader_args as { router?: string } | null)?.router === name,
		).length;
	} finally {
		await closeContext(ctx);
	}
}

function splitCsv(s: string): string[] {
	if (!s) return [];
	return s.split(",").map((p) => p.trim());
}

function requireFlag(value: string | undefined, flag: string): asserts value is string {
	if (!value || !value.trim()) {
		throw new HelpfulError({
			kind: "input_error",
			message: `${flag} is required`,
			hint: "Run `membot router add --help` for usage.",
		});
	}
}

function parsePositiveInt(raw: string, flag: string): number {
	const n = Number.parseInt(raw, 10);
	if (!Number.isFinite(n) || n <= 0) {
		throw new HelpfulError({
			kind: "input_error",
			message: `${flag} must be a positive integer (got: ${raw})`,
			hint: `Pass an integer in milliseconds, e.g. \`${flag} 60000\`.`,
		});
	}
	return n;
}

function interpolateForDisplay(args: readonly string[], vars: Record<string, string>, url: string): string {
	return args
		.map((arg) =>
			arg.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (_match, name: string) => {
				if (name === "url") return url;
				return vars[name] ?? `{${name}}`;
			}),
		)
		.join(" ");
}

/**
 * Argv-only primary spawn used by `membot router test --exec`. Kept
 * separate from the plugin's own runner because `test --exec` doesn't
 * have a full AppContext — it's a "what would happen if I ingested this"
 * preview, not a real ingest.
 */
async function spawnPrimary(router: Router, vars: Record<string, string>, url: string): Promise<Uint8Array> {
	const args = router.args.map((arg) =>
		arg.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (_match, name: string) => {
			if (name === "url") return url;
			const value = vars[name];
			if (value === undefined) {
				throw new HelpfulError({
					kind: "input_error",
					message: `router placeholder {${name}} has no value`,
					hint: `Add a named capture group "(?<${name}>...)" to the router's url_pattern, or remove {${name}} from args/stdin via \`membot router add\`.`,
				});
			}
			return value;
		}),
	);
	const stdinPayload = router.stdin
		? router.stdin.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (_match, name: string) => {
				if (name === "url") return url;
				return vars[name] ?? `{${name}}`;
			})
		: null;

	const proc = Bun.spawn({
		cmd: [router.command, ...args],
		stdin: stdinPayload ? new TextEncoder().encode(stdinPayload) : undefined,
		stdout: "pipe",
		stderr: "pipe",
	});
	const killTimer = setTimeout(() => {
		try {
			proc.kill("SIGKILL");
		} catch {
			// best-effort
		}
	}, router.timeout_ms);
	let exitCode: number;
	let stdout: ArrayBuffer;
	let stderr: ArrayBuffer;
	try {
		[exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout as ReadableStream).arrayBuffer(),
			new Response(proc.stderr as ReadableStream).arrayBuffer(),
		]);
	} finally {
		clearTimeout(killTimer);
	}
	if (exitCode !== 0) {
		const stderrText = new TextDecoder().decode(stderr).trim().slice(-500);
		throw new HelpfulError({
			kind: "network_error",
			message: `router "${router.name}" command "${router.command}" exited ${exitCode}${stderrText ? `: ${stderrText}` : ""}`,
			hint: `Run \`${router.command} ${args.join(" ")}\` manually to reproduce.`,
		});
	}
	return new Uint8Array(stdout);
}
