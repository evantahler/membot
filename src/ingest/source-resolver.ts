import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import picomatch from "picomatch";
import { asHelpful, HelpfulError } from "../errors.ts";

export type ResolvedSource =
	| { kind: "inline"; text: string; logicalHint: string | null }
	| { kind: "url"; url: string; logicalHint: string | null }
	| { kind: "local-files"; entries: ResolvedLocalEntry[]; basePath: string };

export interface ResolvedLocalEntry {
	absPath: string;
	/** Path relative to the base; used to derive a default logical_path. */
	relPath: string;
}

export interface ResolveOptions {
	include?: string;
	exclude?: string;
	followSymlinks?: boolean;
}

const DEFAULT_EXCLUDES = ["**/node_modules/**", "**/.git/**", "**/.DS_Store", "**/dist/**", "**/.cache/**"];

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
	if (source.startsWith("http://") || source.startsWith("https://")) {
		return { kind: "url", url: source, logicalHint: null };
	}

	const followSymlinks = options.followSymlinks !== false;
	const includeMatchers = (options.include ?? "**/*")
		.split(",")
		.map((g) => g.trim())
		.filter(Boolean);
	const excludeMatchers = [
		...DEFAULT_EXCLUDES,
		...(options.exclude ?? "")
			.split(",")
			.map((g) => g.trim())
			.filter(Boolean),
	];

	if (isGlob(source)) {
		const base = globBase(source);
		try {
			const realBase = await realpath(base);
			return walk(realBase, [source, ...includeMatchers], excludeMatchers, followSymlinks);
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
		return {
			kind: "local-files",
			basePath: abs,
			entries: [{ absPath: abs, relPath: source.split(sep).pop() ?? source }],
		};
	}

	if (st.isDirectory()) {
		const realBase = await realpath(abs);
		return walk(realBase, includeMatchers, excludeMatchers, followSymlinks);
	}

	throw new HelpfulError({
		kind: "input_error",
		message: `${source} is neither a file, directory, nor URL`,
		hint: `Pass a file path, directory, glob (e.g. "docs/**/*.md"), URL, or "inline:<text>".`,
	});
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
 * Recursively walk `base`, returning files matched by `includes` and not
 * matched by `excludes`. Both globsets match against the entry's path
 * relative to `base`. Symlinks are followed when `followSymlinks` is true,
 * with cycles detected via a realpath cache.
 */
async function walk(
	base: string,
	includes: string[],
	excludes: string[],
	followSymlinks: boolean,
): Promise<ResolvedSource> {
	const seen = new Set<string>();
	const entries: ResolvedLocalEntry[] = [];

	const isInclude = picomatch(includes, { dot: false, nocase: false });
	const isExclude = excludes.length ? picomatch(excludes, { dot: false }) : null;

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
		entries.push({ absPath: real, relPath: relForMatch });
	}

	return { kind: "local-files", basePath: base, entries };
}

async function readdir(path: string): Promise<string[]> {
	const fs = await import("node:fs/promises");
	return fs.readdir(path);
}
