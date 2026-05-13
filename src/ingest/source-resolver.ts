import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import picomatch from "picomatch";
import { asHelpful, HelpfulError } from "../errors.ts";
import { findSourceByName, findSourceForInput, listSources } from "./sources/registry.ts";
import type { Entry, EnumerateCtx, SourcePlugin } from "./sources/types.ts";

/**
 * Expand a leading `~` or `~/` to the user's home directory. The shell does
 * this for us when the arg is unquoted, but `bun dev add "~/foo/*.md"` passes
 * the literal `~` through, and `path.resolve("~/foo")` treats `~` as a
 * regular directory name. We patch it up so quoted args work like users
 * expect. Inline literals and URLs are caught earlier and never reach here.
 */
function expandHome(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/") || p.startsWith(`~${sep}`)) return join(homedir(), p.slice(2));
	return p;
}

export type ResolvedSource =
	| { kind: "inline"; text: string; logicalHint: string | null }
	| {
			kind: "plugin";
			plugin: SourcePlugin;
			raw: string;
			entries: Entry[];
	  }
	| { kind: "local-files"; entries: ResolvedLocalEntry[]; basePath: string; filtered?: boolean };

export interface ResolvedLocalEntry {
	/** Absolute filesystem path (post-realpath). */
	absPath: string;
	/**
	 * Path relative to the walk base. Used when the caller passes an
	 * explicit `logical_path` *prefix* (directory/glob mode) — entries land
	 * at `{prefix}/{relPathFromBase}`. For default logical_paths we use
	 * `absPath` directly so paths from different filesystems don't collide.
	 */
	relPathFromBase: string;
}

export interface ResolveOptions {
	include?: string;
	exclude?: string;
	followSymlinks?: boolean;
	/**
	 * Force a specific source plugin by name when the input matches a URL.
	 * Bypasses URL-based matching. Has no effect on scheme sources
	 * (apple-notes:) or local files.
	 */
	pluginOverride?: string;
	/**
	 * Context handed to a plugin's `enumerate` when one matches. Required
	 * whenever the source could resolve to a plugin (URL or scheme prefix);
	 * unused for local files / inline literals. Production callers pass
	 * `{ config: ctx.config, logger: ctx.logger }` from `AppContext`.
	 */
	enumerateCtx?: EnumerateCtx;
}

const DEFAULT_EXCLUDES = ["**/node_modules/**", "**/.git/**", "**/.DS_Store", "**/dist/**", "**/.cache/**"];

/**
 * Expand a user-supplied include/exclude pattern into a small set of
 * gitignore-ish equivalents so common spellings all do the intuitive thing.
 * Examples (all exclude the whole subtree): a bare name like `node_modules`,
 * a trailing-slash form like `node_modules/`, the shell-style `node_modules`
 * followed by single-star, the canonical doublestar forms — every spelling
 * a user would reasonably reach for ends up matching nested files.
 * Patterns starting with `**`-slash, `/`, or `./` are considered anchored
 * and are not given an any-depth variant. `DEFAULT_EXCLUDES` are already
 * canonical and bypass this helper.
 */
export function expandUserPattern(p: string): string[] {
	const out = new Set<string>([p]);
	const anchored = p.startsWith("**/") || p.startsWith("/") || p.startsWith("./");
	const hasSlash = p.includes("/");
	const hasGlob = /[*?[\]{}!]/.test(p);
	// Path-like patterns ("foo/bar", "node_modules/*") imply the user is
	// thinking about a directory tree — match at any depth. Bare globs like
	// "*.md" are left alone so they keep their anchored top-level meaning.
	if (hasSlash && !anchored) out.add(`**/${p}`);
	if (p.endsWith("/*") && !p.endsWith("/**/*")) {
		const base = p.slice(0, -2);
		out.add(`${base}/**`);
		if (!anchored) out.add(`**/${base}/**`);
	}
	if (p.endsWith("/")) {
		const base = p.slice(0, -1);
		out.add(`${base}/**`);
		if (!anchored) out.add(`**/${base}/**`);
	}
	// Bare name with no slashes and no glob chars (e.g. "node_modules",
	// "dist") → treat as a directory match anywhere in the tree.
	if (!hasSlash && !hasGlob) {
		out.add(`**/${p}`);
		out.add(`**/${p}/**`);
	}
	return [...out];
}

/**
 * Polymorphic source-arg expander. Accepts:
 *   - "inline:<text>"             → inline literal
 *   - "http://..." | "https://..." → URL (fetched downstream by fetcher)
 *   - existing file               → single-file local
 *   - existing directory          → recursive walk (symlinks via realpath cache)
 *   - glob pattern                → picomatch-filtered walk
 *
 * Symlink loops are broken via a realpath cache. Include / exclude are
 * applied to the entry's path *relative to the base* so users don't need
 * absolute-path globs.
 */
export async function resolveSource(source: string, options: ResolveOptions = {}): Promise<ResolvedSource> {
	if (source.startsWith("inline:")) {
		return { kind: "inline", text: source.slice("inline:".length), logicalHint: null };
	}
	if (options.pluginOverride) {
		const named = findSourceByName(options.pluginOverride);
		if (!named) {
			const available = listSources()
				.map((p) => p.name)
				.join(", ");
			throw new HelpfulError({
				kind: "input_error",
				message: `unknown source plugin '${options.pluginOverride}'`,
				hint: `Pick one of: ${available}.`,
			});
		}
		return await resolveViaPlugin(named, source, requireEnumerateCtx(options));
	}
	const plugin = findSourceForInput(source);
	if (plugin) {
		return await resolveViaPlugin(plugin, source, requireEnumerateCtx(options));
	}

	// We dropped the generic-web catch-all alongside Playwright. An http(s)
	// URL that doesn't claim a specific plugin is now a clear input error
	// (better than the misleading "not_found" the local-file fallthrough
	// would produce).
	if (/^https?:\/\//i.test(source)) {
		const names = listSources()
			.filter((p) => p.match.kind === "url")
			.map((p) => p.name)
			.join(", ");
		throw new HelpfulError({
			kind: "input_error",
			message: `no source plugin matches: ${source}`,
			hint: `Pass a URL recognized by one of: ${names}. To ingest arbitrary web content, download the file locally and run \`membot add <path>\`.`,
		});
	}

	source = expandHome(source);

	const followSymlinks = options.followSymlinks !== false;
	const userIncludesRaw = options.include
		? options.include
				.split(",")
				.map((g) => g.trim())
				.filter(Boolean)
		: [];
	const userExcludesRaw = (options.exclude ?? "")
		.split(",")
		.map((g) => g.trim())
		.filter(Boolean);
	const userIncludesExpanded = userIncludesRaw.flatMap(expandUserPattern);
	const userExcludesExpanded = userExcludesRaw.flatMap(expandUserPattern);
	const excludeMatchers = [...DEFAULT_EXCLUDES, ...userExcludesExpanded];
	// Single-file matchers run against the absolute path so shell-expanded
	// globs (where each file lands here individually) still honor excludes.
	const isExcludeAbs = picomatch(excludeMatchers, { dot: false });
	const isIncludeAbs = userIncludesExpanded.length
		? picomatch(userIncludesExpanded, { dot: false, nocase: false })
		: null;

	if (isGlob(source)) {
		const base = globBase(source);
		const remainder = globRemainder(source);
		try {
			const realBase = await realpath(base);
			// Source glob acts as a hard filter; user includes (if any) further
			// narrow the result via AND. Pass them as a separate matcher so the
			// two sets aren't picomatch-OR'd together.
			const extraIncludes = userIncludesExpanded.length > 0 ? [userIncludesExpanded] : [];
			return walk(realBase, [remainder], excludeMatchers, followSymlinks, extraIncludes);
		} catch (err) {
			throw asHelpful(
				err,
				`while resolving glob base ${base}`,
				`Check that the directory ${base} exists.`,
				"not_found",
			);
		}
	}

	const abs = resolve(source);
	let st: Awaited<ReturnType<typeof stat>>;
	try {
		st = await stat(abs);
	} catch (err) {
		throw asHelpful(
			err,
			`while stat'ing ${source}`,
			`Check that the path exists. Run \`ls ${source}\`. For URLs, prefix with http:// or https://.`,
			"not_found",
		);
	}

	if (st.isFile()) {
		const real = await realpath(abs);
		// Shell-expanded globs (e.g. zsh expanding `~/foo/**/*.md`) deliver
		// each match here individually, so this branch must enforce both
		// DEFAULT_EXCLUDES and the user's own --include/--exclude. Otherwise
		// `node_modules` paths slip through whenever the shell expanded for us.
		if (isExcludeAbs(real)) {
			return { kind: "local-files", basePath: real, entries: [], filtered: true };
		}
		if (isIncludeAbs && !isIncludeAbs(real)) {
			return { kind: "local-files", basePath: real, entries: [], filtered: true };
		}
		return {
			kind: "local-files",
			basePath: real,
			entries: [{ absPath: real, relPathFromBase: real.split(sep).pop() ?? real }],
		};
	}

	if (st.isDirectory()) {
		const realBase = await realpath(abs);
		const dirIncludes = userIncludesExpanded.length > 0 ? userIncludesExpanded : ["**/*"];
		return walk(realBase, dirIncludes, excludeMatchers, followSymlinks);
	}

	throw new HelpfulError({
		kind: "input_error",
		message: `${source} is neither a file, directory, nor URL`,
		hint: `Pass a file path, directory, glob (e.g. "docs/**/*.md"), URL, or "inline:<text>".`,
	});
}

/**
 * Resolve a plugin-matched source (URL or scheme prefix). The plugin's
 * own `enumerate` is the source of truth — URL plugins yield one entry,
 * scheme plugins like apple-notes yield many. The plugin owns whatever
 * resources (sqlite reader, browser cookies) it needs to open and close
 * during enumeration.
 */
async function resolveViaPlugin(plugin: SourcePlugin, source: string, ctx: EnumerateCtx): Promise<ResolvedSource> {
	const entries = await plugin.enumerate(source, ctx);
	return { kind: "plugin", plugin, raw: source, entries };
}

/**
 * Pluck `enumerateCtx` from options, raising a programmer-error when a
 * caller forgot to pass it. Caught early so a bulk-import plugin doesn't
 * blow up mid-pagination with a confusing "config is undefined" error.
 */
function requireEnumerateCtx(options: ResolveOptions): EnumerateCtx {
	if (!options.enumerateCtx) {
		throw new HelpfulError({
			kind: "internal_error",
			message: "resolveSource: plugin source needs an enumerateCtx but none was provided",
			hint: "Pass `{ enumerateCtx: { config: ctx.config, logger: ctx.logger } }` from the calling operation.",
		});
	}
	return options.enumerateCtx;
}

/** Crude glob detector — matches what picomatch treats as a pattern. */
export function isGlob(s: string): boolean {
	return /[*?[\]{}!]/.test(s);
}

/** Take the static directory prefix of a glob (everything before the first wildcard). */
export function globBase(glob: string): string {
	const parts = glob.split(sep);
	const out: string[] = [];
	for (const p of parts) {
		if (/[*?[\]{}!]/.test(p)) break;
		out.push(p);
	}
	const base = out.join(sep);
	return base.length === 0 || !isAbsolute(base) ? resolve(base || ".") : base;
}

/**
 * Take the wildcard portion of a glob — everything from the first segment
 * containing a wildcard onward. We strip the static prefix so the matcher
 * runs against entry paths relative to `globBase`. Without this, a glob like
 * `docs/star-star/star.md` never matches anything under base=`docs/`, since
 * walk() exposes `sub/file.md` to picomatch, not `docs/sub/file.md`.
 */
export function globRemainder(glob: string): string {
	const parts = glob.split(sep);
	const wildcardIdx = parts.findIndex((p) => /[*?[\]{}!]/.test(p));
	if (wildcardIdx === -1) return glob;
	return parts.slice(wildcardIdx).join(sep);
}

/**
 * Recursively walk `base`, returning files matched by `includes` and not
 * matched by `excludes`. Both globsets match against the entry's path
 * relative to `base`. Symlinks are followed when `followSymlinks` is true,
 * with cycles detected via a realpath cache. `extraIncludeSets` is a list
 * of additional include groups, each ANDed onto the primary `includes` —
 * use it when two filters must both match (e.g. source glob + --include).
 */
async function walk(
	base: string,
	includes: string[],
	excludes: string[],
	followSymlinks: boolean,
	extraIncludeSets: string[][] = [],
): Promise<ResolvedSource> {
	const seen = new Set<string>();
	const entries: ResolvedLocalEntry[] = [];

	const isInclude = picomatch(includes, { dot: false, nocase: false });
	const extraMatchers = extraIncludeSets.map((set) => picomatch(set, { dot: false, nocase: false }));
	const isExclude = excludes.length ? picomatch(excludes, { dot: false }) : null;
	// Directory-prune patterns: derived from excludes by stripping a trailing
	// `/**` or `/*`. Without this we descend into massive subtrees (e.g.
	// every `node_modules/` under a workspace) before discarding files one
	// by one — which on real machines presents as a hang.
	const dirPrunePatterns = excludes
		.map((p) => (p.endsWith("/**") ? p.slice(0, -3) : p.endsWith("/*") ? p.slice(0, -2) : p))
		.filter((p) => p.length > 0);
	const isExcludeDir = dirPrunePatterns.length ? picomatch(dirPrunePatterns, { dot: false }) : null;

	const queue: string[] = [base];
	while (queue.length > 0) {
		const cur = queue.shift();
		if (cur === undefined) break;
		let real: string;
		try {
			real = await realpath(cur);
		} catch {
			continue;
		}
		if (seen.has(real)) continue;
		seen.add(real);
		let st: Awaited<ReturnType<typeof stat>>;
		try {
			st = await stat(real);
		} catch {
			continue;
		}
		if (st.isSymbolicLink() && !followSymlinks) continue;
		if (st.isDirectory()) {
			const rel = relative(base, real);
			if (rel.length > 0 && isExcludeDir?.(rel)) continue;
			let names: string[];
			try {
				names = await readdir(real);
			} catch {
				continue;
			}
			for (const name of names) {
				queue.push(join(real, name));
			}
			continue;
		}
		if (!st.isFile()) continue;
		const rel = relative(base, real);
		const relForMatch = rel.length === 0 ? (cur.split(sep).pop() ?? cur) : rel;
		if (isExclude?.(relForMatch)) continue;
		if (!isInclude(relForMatch)) continue;
		if (extraMatchers.some((m) => !m(relForMatch))) continue;
		entries.push({ absPath: real, relPathFromBase: relForMatch });
	}

	return { kind: "local-files", basePath: base, entries };
}

async function readdir(path: string): Promise<string[]> {
	const fs = await import("node:fs/promises");
	return fs.readdir(path);
}
