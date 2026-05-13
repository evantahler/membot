import { z } from "zod";
import { HelpfulError } from "../../errors.ts";
import type { ApiKeyLoginEntry, CliToolLoginEntry, PluginCtx, SourcePlugin } from "./types.ts";

/**
 * Append-only plugin registry. Plugins call `registerSource(plugin)` at
 * module-load time; the side-effect imports in `./index.ts` are what
 * populate the array. Order matters — `findSourceForInput` walks the
 * list and returns the first match.
 *
 * Registrations from a non-matching `platform` are silently dropped at
 * load time. That lets us ship apple-notes in the binary on every OS
 * while only exposing it on darwin.
 */
const REGISTRY: SourcePlugin[] = [];
const REGISTERED_NAMES = new Set<string>();

/**
 * Register a plugin. Must be called at module-load time (via the
 * side-effect imports in `./index.ts`) so the registry is populated
 * before `MembotConfigSchema` is constructed.
 *
 * Refuses duplicate names — two plugins claiming the same name would
 * fight over the same `files.downloader` value and corrupt refresh
 * dispatch. Scheme-prefix collisions are also rejected.
 */
export function registerSource<C extends Record<string, unknown>, A extends Record<string, unknown>>(
	plugin: SourcePlugin<C, A>,
): void {
	if (plugin.platform && !plugin.platform.includes(process.platform)) {
		return;
	}
	if (REGISTERED_NAMES.has(plugin.name)) {
		throw new HelpfulError({
			kind: "internal_error",
			message: `source plugin "${plugin.name}" registered twice`,
			hint: "Check src/ingest/sources/index.ts for a duplicate import.",
		});
	}
	if (plugin.match.kind === "scheme") {
		for (const existing of REGISTRY) {
			if (existing.match.kind === "scheme" && existing.match.prefix === plugin.match.prefix) {
				throw new HelpfulError({
					kind: "internal_error",
					message: `scheme prefix "${plugin.match.prefix}" claimed by both "${existing.name}" and "${plugin.name}"`,
					hint: "Each scheme plugin needs a unique prefix. Pick a different one or merge the plugins.",
				});
			}
		}
	}
	REGISTERED_NAMES.add(plugin.name);
	REGISTRY.push(plugin as SourcePlugin);
}

/** Read-only view of every registered plugin, in registration order. */
export function listSources(): readonly SourcePlugin[] {
	return REGISTRY;
}

/** Lookup by stable name (used by refresh to replay a persisted plugin). */
export function findSourceByName(name: string): SourcePlugin | null {
	return REGISTRY.find((p) => p.name === name) ?? null;
}

/**
 * Find the first plugin that claims `input`. Scheme prefixes are checked
 * first so an `apple-notes:` string never falls through to URL matching.
 * URL plugins are tried in registration order; if no plugin matches
 * an http(s) URL, returns `null` (the caller raises a HelpfulError).
 *
 * Returns `null` when the input isn't a URL and doesn't match any
 * scheme — callers handle that as "not a remote source" (local file,
 * glob, inline literal).
 */
export function findSourceForInput(input: string): SourcePlugin | null {
	for (const p of REGISTRY) {
		if (p.match.kind === "scheme" && input.startsWith(p.match.prefix)) return p;
	}
	let parsed: URL;
	try {
		parsed = new URL(input);
	} catch {
		return null;
	}
	for (const p of REGISTRY) {
		if (p.match.kind === "url" && p.match.matches(parsed)) return p;
	}
	return null;
}

/**
 * Collect every login entry declared by a plugin, deduped within each
 * kind. The `membot login` command runs each `cli_tool` entry's
 * `setupCommand` interactively and prints instructions for each
 * `api_key` entry. Multiple plugins can share the same login (all
 * three Google plugins collapse to a single `gws auth setup` step).
 */
export function collectLoginEntries(): {
	cliTool: CliToolLoginEntry[];
	apiKey: ApiKeyLoginEntry[];
} {
	const cliTool = new Map<string, CliToolLoginEntry>();
	const apiKey = new Map<string, ApiKeyLoginEntry>();
	for (const p of REGISTRY) {
		if (!p.logins) continue;
		for (const login of p.logins) {
			if (login.kind === "cli_tool") {
				if (!cliTool.has(login.setupCommand)) cliTool.set(login.setupCommand, login);
			} else {
				if (!apiKey.has(login.url)) apiKey.set(login.url, login);
			}
		}
	}
	return { cliTool: [...cliTool.values()], apiKey: [...apiKey.values()] };
}

/**
 * Compose the `downloaders` config slice from every plugin that declared
 * an `auth.configSchema`. Each plugin's slice is nested under its
 * `auth.configKey`, defaulted via the plugin's own zod parsing so omitted
 * keys land at their declared defaults. The composed object is what
 * `MembotConfigSchema.downloaders` points at — single source of truth,
 * no hand-edits required when a new plugin lands.
 */
export function buildDownloadersConfigSchema(): z.ZodTypeAny {
	const shape: Record<string, z.ZodTypeAny> = {};
	for (const p of REGISTRY) {
		const cfg = p.config;
		if (!cfg) continue;
		const schema = cfg.schema;
		shape[cfg.key] = schema.default(() => schema.parse({}));
	}
	const obj = z.object(shape);
	return obj.default(() => obj.parse({}));
}

/**
 * Typed accessor for a plugin's slice of the config. Plugins call this
 * to read their `api_key` / other declared fields without having to cast
 * `ctx.config.downloaders[<key>]` themselves. The cast is contained here
 * because the composite shape is built at runtime — TypeScript can't
 * statically know it.
 */
export function pluginConfig<C extends Record<string, unknown>, A extends Record<string, unknown>>(
	ctx: PluginCtx,
	plugin: SourcePlugin<C, A>,
): C {
	const cfg = plugin.config;
	if (!cfg) {
		throw new HelpfulError({
			kind: "internal_error",
			message: `plugin "${plugin.name}" has no config slice`,
			hint: "Only plugins with `config` set may call pluginConfig; this is a programmer error.",
		});
	}
	const downloaders = ctx.config.downloaders as unknown as Record<string, unknown>;
	const slice = downloaders[cfg.key];
	if (slice === undefined || slice === null) {
		throw new HelpfulError({
			kind: "internal_error",
			message: `config slice for "${plugin.name}" missing under downloaders.${cfg.key}`,
			hint: "Re-run; if the failure persists, delete ~/.membot/config.json to regenerate from defaults.",
		});
	}
	return slice as C;
}

/**
 * Helper for plugins that need to wrap a one-shot fetch in their own
 * batch fetcher (refresh-time replay does this). The returned fetcher
 * holds the plugin's session open across exactly one call, then closes.
 */
export async function withOneShotFetcher<A extends Record<string, unknown>, R>(
	plugin: SourcePlugin<Record<string, unknown>, A>,
	ctx: PluginCtx,
	body: (fetch: (entry: import("./types.ts").Entry<A>) => Promise<import("./types.ts").DownloadedRemote>) => Promise<R>,
): Promise<R> {
	const fetcher = await plugin.openBatchFetcher(ctx);
	try {
		return await body((entry) => (fetcher as unknown as import("./types.ts").BatchFetcher<A>).fetch(entry, ctx));
	} finally {
		await fetcher.close();
	}
}

export type { SourcePlugin } from "./types.ts";

/**
 * Default logical-path hint for a URL: `remotes/{host}/{path}` with
 * query/fragment dropped. URL plugins reach for this in `enumerate`
 * to populate `Entry.logicalPathHint`. Mirrors what the host falls
 * back to when no plugin supplies a hint.
 */
export function defaultUrlHint(url: URL): string {
	const tail = url.pathname.replace(/^\/+/, "").replace(/\/+$/, "") || "index";
	return `remotes/${url.hostname}/${tail}`;
}

/**
 * Render the per-plugin section that's spliced into `membot add --help`
 * (and the MCP `membot_add` description, and the README / skill files
 * via the docs codegen). One source of truth for the registered source
 * list — adding a plugin reflects everywhere on next launch.
 *
 * Format is plain markdown with one bullet per plugin: `- <name> — <desc>`
 * followed by indented `example: <url-or-scheme>` lines.
 */
export function renderSourceList(): string {
	const lines: string[] = [];
	for (const p of listSources()) {
		const authBadge = p.config ? "[api_key]" : p.logins?.[0]?.kind === "cli_tool" ? "[cli_tool]" : "";
		const head = authBadge ? `- ${p.name} ${authBadge} — ${p.description}` : `- ${p.name} — ${p.description}`;
		lines.push(head);
		for (const ex of p.examples) {
			lines.push(`    example: ${ex}`);
		}
	}
	return lines.join("\n");
}
