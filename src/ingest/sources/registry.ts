import { z } from "zod";
import { HelpfulError } from "../../errors.ts";
import type { ApiKeyLoginEntry, BrowserLoginEntry, PluginCtx, SourcePlugin } from "./types.ts";

/**
 * Append-only plugin registry. Plugins call `registerSource(plugin)` at
 * module-load time; the side-effect imports in `./index.ts` are what
 * populate the array. Order matters — `findSourceForInput` walks the
 * list and returns the first match, so generic-web must be last.
 *
 * Registrations from a non-matching `platform` are silently dropped at
 * load time. That lets us ship apple-notes in the binary on every OS
 * while only exposing it on darwin.
 */
const REGISTRY: SourcePlugin[] = [];
const REGISTERED_NAMES = new Set<string>();

/**
 * Register a plugin. Must be called at module-load time (side-effect
 * imports in `./index.ts`) so the registry is populated before
 * `MembotConfigSchema` is constructed.
 *
 * Refuses duplicate names — two plugins claiming the same name would
 * fight over the same `files.downloader` value and would corrupt
 * refresh dispatch. Scheme-prefix collisions are also rejected.
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
	// Two plugins are allowed to share a `config.key` (e.g. linear + linear-team
	// both read from `downloaders.linear`), but only if they hand the same
	// schema reference — otherwise `buildDownloadersConfigSchema` would silently
	// last-write-wins on the slice. Catch the mistake at registration time.
	if (plugin.config) {
		for (const existing of REGISTRY) {
			if (
				existing.config &&
				existing.config.key === plugin.config.key &&
				existing.config.schema !== plugin.config.schema
			) {
				throw new HelpfulError({
					kind: "internal_error",
					message: `config key "${plugin.config.key}" claimed by both "${existing.name}" and "${plugin.name}" with different schemas`,
					hint: "When two plugins share a config slice, both must import the same schema reference. Lift the schema into a shared module.",
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
 * URL plugins are tried in registration order; generic-web (registered
 * last) acts as the catch-all for http(s) URLs no specific plugin took.
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
 * Collect every login entry declared by a plugin, deduped by URL within
 * each kind. The `membot login` command renders one button per
 * browser-auth entry and one set of instructions per api-key entry.
 * Multiple plugins can share the same login (all three Google plugins
 * collapse to one Google button).
 */
export function collectLoginEntries(): {
	browser: BrowserLoginEntry[];
	apiKey: ApiKeyLoginEntry[];
} {
	const browser = new Map<string, BrowserLoginEntry>();
	const apiKey = new Map<string, ApiKeyLoginEntry>();
	for (const p of REGISTRY) {
		if (!p.logins) continue;
		for (const login of p.logins) {
			if (login.kind === "browser") {
				if (!browser.has(login.url)) browser.set(login.url, login);
			} else {
				if (!apiKey.has(login.url)) apiKey.set(login.url, login);
			}
		}
	}
	return { browser: [...browser.values()], apiKey: [...apiKey.values()] };
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
		const authBadge = p.config ? "[api_key]" : p.logins?.[0]?.kind === "browser" ? "[browser]" : "";
		const head = authBadge ? `- ${p.name} ${authBadge} — ${p.description}` : `- ${p.name} — ${p.description}`;
		lines.push(head);
		for (const ex of p.examples) {
			lines.push(`    example: ${ex}`);
		}
	}
	return lines.join("\n");
}
