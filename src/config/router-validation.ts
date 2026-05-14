import { z } from "zod";
import { HelpfulError } from "../errors.ts";
import type { MembotConfig } from "./schemas.ts";

/**
 * Built-in post-processor names recognized by the custom-command plugin.
 * Adding a new built-in: add the literal here and a branch in
 * `src/ingest/sources/post-processors.ts`. Users can also supply a
 * `{command, args}` object instead of one of these names; that path is
 * validated separately by `PostProcessShellSchema`.
 */
export const BUILTIN_POST_PROCESSORS = ["passthrough", "docmd", "html-to-markdown"] as const;
export type BuiltinPostProcessor = (typeof BUILTIN_POST_PROCESSORS)[number];

/**
 * Shell-command flavor of post-processing. The fetched bytes are piped to
 * this command's stdin; its stdout becomes the post-processed bytes.
 * Same argv-array semantics as the primary fetch — no shell interpolation.
 */
export const PostProcessShellSchema = z
	.object({
		command: z.string().min(1).describe("Executable to invoke. Resolved on PATH at fetch time."),
		args: z
			.array(z.string())
			.default([])
			.describe("Argv elements. {var} placeholders are substituted from url_pattern named groups."),
		timeout_ms: z.number().int().positive().default(60_000).describe("Kill the post-process spawn past this duration."),
	})
	.describe(
		"Shell-command post-processor. Bytes are piped on stdin; stdout becomes the post-processed bytes. " +
			"This is a footgun by design — you opt into running this command on every ingest and refresh.",
	);
export type PostProcessShell = z.infer<typeof PostProcessShellSchema>;

/**
 * `post_process` accepts either a built-in name (`"passthrough"` / `"docmd"` /
 * `"html-to-markdown"`) or an explicit `{command, args}` shell-command object.
 * Defaults to "passthrough" when omitted.
 */
export const PostProcessSchema = z
	.union([z.enum(BUILTIN_POST_PROCESSORS), PostProcessShellSchema])
	.default("passthrough")
	.describe(
		"How to post-process the command's stdout before it flows into convert/chunk/embed. " +
			"Either a built-in name or a {command, args, timeout_ms?} shell-command object.",
	);
export type PostProcessSpec = z.infer<typeof PostProcessSchema>;

const ROUTER_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/i;

/**
 * One user-defined URL router. Every field is required at use-time except
 * the explicitly defaulted ones. `name` is the persisted identity referenced
 * from `downloader_args.router`; if a user renames a router, existing rows
 * that pointed at the old name will fail to refresh until the router is
 * re-added under the old name.
 */
export const RouterSchema = z
	.object({
		name: z
			.string()
			.regex(ROUTER_NAME_RE, "router name must be 1-63 chars, alphanumeric plus _ and -, starting with [a-z0-9]")
			.describe("Unique id. Persisted as downloader_args.router so refresh can replay this exact router."),
		url_pattern: z
			.string()
			.min(1)
			.describe(
				"JS regex (string form) matched against the full URL. Named groups (?<name>...) are extracted as " +
					"variables for {var} substitution in args and stdin. First router with a matching pattern wins.",
			),
		command: z.string().min(1).describe("Executable to invoke. Resolved on PATH at fetch time."),
		args: z
			.array(z.string())
			.default([])
			.describe(
				"Argv elements. {var} placeholders are substituted from url_pattern named groups; {url} is the full URL. " +
					"Argv array — no shell, no string interpolation.",
			),
		mime_type: z
			.string()
			.min(1)
			.default("text/markdown")
			.describe(
				"Mime type of the command's stdout (after post-processing). Flows through the existing converter dispatch.",
			),
		post_process: PostProcessSchema,
		timeout_ms: z
			.number()
			.int()
			.positive()
			.default(60_000)
			.describe("Kill the primary fetch spawn past this duration. Throws HelpfulError on timeout."),
		stdin: z
			.string()
			.nullable()
			.default(null)
			.describe("Optional string to feed on the primary command's stdin, with {var} substitution. Default null."),
	})
	.describe("One user-defined URL router. See `membot router add --help` for examples.");
export type Router = z.infer<typeof RouterSchema>;

/**
 * Compile a router's url_pattern into a RegExp. Throws HelpfulError when
 * the pattern is malformed. Cached once at config-load and again whenever
 * `membot router add/remove` mutates the array.
 */
export function compileRouterPattern(router: Router): RegExp {
	try {
		return new RegExp(router.url_pattern);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new HelpfulError({
			kind: "input_error",
			message: `router "${router.name}" has invalid url_pattern: ${message}`,
			hint: `Fix the regex (it's parsed as a JS RegExp). Run \`membot router list\` to inspect, or \`membot router add --name ${router.name} --url-pattern '<new-pattern>'\` to replace it.`,
		});
	}
}

/**
 * Validate that the array of routers is internally consistent:
 * - names are unique
 * - every url_pattern compiles
 * - every {var} placeholder in args or stdin references a known named group
 * Throws HelpfulError on the first violation.
 */
export function validateRouters(routers: readonly Router[]): void {
	const seen = new Set<string>();
	for (const router of routers) {
		if (seen.has(router.name)) {
			throw new HelpfulError({
				kind: "input_error",
				message: `duplicate router name: ${router.name}`,
				hint: `Each router under downloaders.custom_routers must have a unique name. Run \`membot router list\` to see existing routers.`,
			});
		}
		seen.add(router.name);
		const re = compileRouterPattern(router);
		const groupNames = collectGroupNames(re);
		const placeholders = collectPlaceholders(router);
		for (const placeholder of placeholders) {
			if (placeholder === "url") continue;
			if (!groupNames.has(placeholder)) {
				throw new HelpfulError({
					kind: "input_error",
					message: `router "${router.name}" references {${placeholder}} but url_pattern has no named group "(?<${placeholder}>...)"`,
					hint: `Add the named group to url_pattern, or remove the {${placeholder}} placeholder from args/stdin. Use {url} for the whole URL.`,
				});
			}
		}
	}
}

/**
 * Pull every `{var}` token out of a router's args + stdin so we can
 * cross-check them against the url_pattern's named groups. The literal
 * token `{url}` is special-cased by the substituter and isn't required
 * to appear as a regex group.
 */
function collectPlaceholders(router: Router): Set<string> {
	const out = new Set<string>();
	const re = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;
	const scan = (s: string): void => {
		for (const m of s.matchAll(re)) {
			const name = m[1];
			if (name) out.add(name);
		}
	};
	for (const arg of router.args) scan(arg);
	if (router.stdin) scan(router.stdin);
	if (typeof router.post_process === "object") {
		for (const arg of router.post_process.args) scan(arg);
	}
	return out;
}

/**
 * Extract the named-capture-group identifiers from a compiled RegExp.
 * Used by `validateRouters` to ensure every {var} placeholder maps to
 * a real group, so we surface the mismatch at config-write time rather
 * than at the next fetch.
 */
function collectGroupNames(re: RegExp): Set<string> {
	const out = new Set<string>();
	const groupRe = /\(\?<([a-zA-Z_][a-zA-Z0-9_]*)>/g;
	for (const m of re.source.matchAll(groupRe)) {
		const name = m[1];
		if (name) out.add(name);
	}
	return out;
}

/**
 * The downloaders.custom_routers config slice. Defaults to an empty array
 * when omitted from config.json. Per-array cross-field invariants
 * (unique names, named-group/placeholder match-up, compilable regex) run
 * via superRefine so they surface with a precise message at load and
 * save time.
 */
export const CustomRoutersSchema = z
	.array(RouterSchema)
	.default([])
	.describe(
		"User-defined URL routers. Each entry matches a URL pattern and delegates the fetch to an external shell command — " +
			"useful for routing Google Docs through `mcpx exec` or any other tool whose auth lives outside membot. " +
			"Manage via `membot router add/list/remove/test`.",
	)
	.superRefine((routers, ctx) => {
		try {
			validateRouters(routers);
		} catch (err) {
			if (err instanceof HelpfulError) {
				ctx.addIssue({ code: "custom", message: err.message });
			} else {
				throw err;
			}
		}
	});
export type CustomRouters = z.infer<typeof CustomRoutersSchema>;

/**
 * Typed accessor for `config.downloaders.custom_routers`. The
 * downloaders config is composed at runtime from every plugin's slice
 * plus a few hand-injected fields, so its inferred type is `unknown` —
 * callers that need the routers cast through this single helper instead
 * of sprinkling `as` everywhere.
 */
export function getCustomRouters(config: MembotConfig): Router[] {
	const downloaders = config.downloaders as { custom_routers?: Router[] } | undefined;
	return downloaders?.custom_routers ?? [];
}

/**
 * Typed updater for `config.downloaders.custom_routers`. Returns a new
 * `MembotConfig` whose downloaders object replaces the router array,
 * preserving every other downloader slice. Used by `membot router
 * add/remove` and any future caller that needs to mutate the array.
 */
export function withCustomRouters(config: MembotConfig, routers: Router[]): MembotConfig {
	const downloaders = (config.downloaders as Record<string, unknown> | undefined) ?? {};
	return {
		...config,
		downloaders: { ...downloaders, custom_routers: routers } as MembotConfig["downloaders"],
	};
}
