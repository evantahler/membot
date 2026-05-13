import { listCurrent, tombstone } from "../../db/files.ts";
import { HelpfulError } from "../../errors.ts";
import { sha256Hex } from "../local-reader.ts";
import {
	type GithubComment,
	type GithubConfig,
	type GithubIssue,
	type GithubTimelineEvent,
	getJson,
	githubConfigSchema,
	githubIssuePath,
	renderIssue,
} from "./github-shared.ts";
import { pluginConfig, registerSource } from "./registry.ts";
import {
	type BatchFetcher,
	type DownloadedRemote,
	defineSourcePlugin,
	type Entry,
	type EnumerateCtx,
} from "./types.ts";

const REPO_SCHEME = "github-repo:";
const SCOPE_RE = /^github-repo:([\w.-]+)\/([\w.-]+)(?::(issues|prs|issues:all|prs:all|all))?$/;

interface GithubRepoArgs extends Record<string, unknown> {
	owner: string;
	repo: string;
	kind: "issues" | "pull";
	number: number;
}

interface ParsedScope {
	owner: string;
	repo: string;
	include: { issues: boolean; prs: boolean };
	state: "open" | "closed" | "all";
}

interface GithubListedIssue {
	number: number;
	html_url: string;
	updated_at: string;
	pull_request?: unknown;
}

/**
 * GitHub repository bulk import. Enumerates every issue and/or PR in a
 * repository, yielding one Entry per item. Source shape:
 * `github-repo:<owner>/<repo>[:<selector>]` where selector ∈
 * {`issues`, `prs`, `issues:all`, `prs:all`, `all`}; default pulls open
 * issues + open PRs.
 *
 * Shares the per-URL GitHub plugin's config slice
 * (`downloaders.github.api_key`) and its fetch + render code. Refresh
 * of a single row re-fetches one issue or PR; `--sync` reconciles.
 *
 * Caveat: with an open-only selector, closing an issue makes it
 * disappear from the live enumerate, so `--sync` will tombstone it. Use
 * `:all` selectors if you want closed items to stay alongside open ones.
 */
const githubRepoPlugin = defineSourcePlugin<GithubConfig, GithubRepoArgs>({
	name: "github-repo",
	description:
		"GitHub repository bulk import — open issues and PRs (selectable, optionally including closed) via the GitHub REST API.",
	examples: [
		"github-repo:facebook/react",
		"github-repo:owner/repo:issues",
		"github-repo:owner/repo:prs:all",
		"github-repo:owner/repo:all",
	],
	notes:
		"Default selector pulls open issues + open PRs. Override with `:issues`, `:prs`, `:issues:all`, `:prs:all`, `:all`. Uses the same API key as the per-URL github plugin (`membot config set downloaders.github.api_key <PAT>` or `GITHUB_TOKEN`). Pass --sync to tombstone items no longer returned by the enumerate; with an open-only selector, closing an item will tombstone it — use `:all` selectors to keep closed items.",
	match: { kind: "scheme", prefix: REPO_SCHEME },
	config: { key: "github", schema: githubConfigSchema },
	logins: [
		{
			kind: "api_key",
			name: "GitHub",
			url: "https://github.com/settings/tokens",
			setupCommand: "membot config set downloaders.github.api_key <PAT>",
			description: "create a fine-grained token with repo:read access (or use GITHUB_TOKEN env var)",
		},
	],
	requiresApiKey: false,
	async enumerate(source, ctx) {
		const scope = parseGithubRepoScope(source);
		const token = resolveToken(ctx);
		const entries: Entry<GithubRepoArgs>[] = [];
		for await (const item of paginateIssues(scope, token)) {
			const isPr = !!item.pull_request;
			if (isPr && !scope.include.prs) continue;
			if (!isPr && !scope.include.issues) continue;
			const cursor: GithubRepoArgs = {
				owner: scope.owner,
				repo: scope.repo,
				kind: isPr ? "pull" : "issues",
				number: item.number,
			};
			entries.push({
				source: item.html_url,
				logicalPathHint: githubIssuePath(scope.owner, scope.repo, cursor.kind, cursor.number),
				mtimeMs: Date.parse(item.updated_at),
				cursor,
			});
		}
		ctx.logger.info(`github-repo:${scope.owner}/${scope.repo} enumerated ${entries.length} entries`);
		return entries;
	},
	rehydrateEntry(source, args) {
		return {
			source,
			logicalPathHint: githubIssuePath(args.owner, args.repo, args.kind, args.number),
			cursor: args,
		};
	},
	probeUnchanged(entry, persisted) {
		if (entry.mtimeMs === undefined || persisted.source_mtime_ms === null) return false;
		return entry.mtimeMs === persisted.source_mtime_ms;
	},
	async openBatchFetcher(): Promise<BatchFetcher<GithubRepoArgs>> {
		return {
			async fetch(entry, ctx): Promise<DownloadedRemote> {
				const cfg = pluginConfig(ctx, githubRepoPlugin);
				const token = (cfg.api_key || process.env.GITHUB_TOKEN || "").trim();
				const { owner, repo, number } = entry.cursor;
				ctx.onProgress?.(`fetching #${number}`);
				const issue = await getJson<GithubIssue>(`/repos/${owner}/${repo}/issues/${number}`, token, entry.source);
				ctx.onProgress?.("fetching comments");
				const comments = await getJson<GithubComment[]>(
					`/repos/${owner}/${repo}/issues/${number}/comments?per_page=100`,
					token,
					entry.source,
				);
				ctx.onProgress?.("fetching timeline");
				const timeline = await getJson<GithubTimelineEvent[]>(
					`/repos/${owner}/${repo}/issues/${number}/timeline?per_page=100`,
					token,
					entry.source,
				);
				const isPr = !!issue.pull_request;
				const markdown = renderIssue(issue, comments, timeline, isPr);
				const bytes = new TextEncoder().encode(markdown);
				return {
					bytes,
					sha256: sha256Hex(bytes),
					mimeType: "text/markdown",
					downloader: "github-repo",
					downloaderArgs: entry.cursor,
					sourceUrl: entry.source,
				};
			},
			async close() {},
		};
	},
	async sync(ctx, source) {
		const scope = parseGithubRepoScope(source);
		const token = resolveToken({ config: ctx.config, logger: ctx.logger });
		const live = new Set<string>();
		for await (const item of paginateIssues(scope, token)) {
			const isPr = !!item.pull_request;
			if (isPr && !scope.include.prs) continue;
			if (!isPr && !scope.include.issues) continue;
			live.add(`${isPr ? "pull" : "issues"}:${item.number}`);
		}
		const prefix = `github/${scope.owner.toLowerCase()}/${scope.repo.toLowerCase()}/`;
		const rows = await listCurrent(ctx.db, { prefix, limit: 100_000 });
		const tombstoned: string[] = [];
		for (const row of rows) {
			if (row.downloader !== "github-repo") continue;
			const args = (row.downloader_args ?? {}) as Record<string, unknown>;
			if (args.owner !== scope.owner || args.repo !== scope.repo) continue;
			const kind = args.kind;
			const number = args.number;
			if ((kind !== "issues" && kind !== "pull") || typeof number !== "number") continue;
			// Honor the selector — sync only reconciles the slice the source asked for.
			if (kind === "pull" && !scope.include.prs) continue;
			if (kind === "issues" && !scope.include.issues) continue;
			const key = `${kind}:${number}`;
			if (live.has(key)) continue;
			await tombstone(ctx.db, row.logical_path, `sync: ${kind}#${number} removed from ${scope.owner}/${scope.repo}`);
			tombstoned.push(row.logical_path);
		}
		return { tombstoned };
	},
});

/**
 * Parse the `github-repo:<owner>/<repo>[:<selector>]` scheme into a
 * structured scope. Selector parsing collapses into `include` + `state`
 * so call sites don't have to re-decide what `issues:all` means.
 */
export function parseGithubRepoScope(source: string): ParsedScope {
	const match = source.match(SCOPE_RE);
	if (!match) {
		throw new HelpfulError({
			kind: "input_error",
			message: `not a valid github-repo source: ${source}`,
			hint: "Use a source like `github-repo:owner/repo` or `github-repo:owner/repo:prs:all`. Selectors: issues, prs, issues:all, prs:all, all.",
		});
	}
	const [, owner, repo, selectorRaw] = match;
	const selector = selectorRaw ?? "";
	switch (selector) {
		case "":
			return { owner: owner as string, repo: repo as string, include: { issues: true, prs: true }, state: "open" };
		case "issues":
			return { owner: owner as string, repo: repo as string, include: { issues: true, prs: false }, state: "open" };
		case "prs":
			return { owner: owner as string, repo: repo as string, include: { issues: false, prs: true }, state: "open" };
		case "issues:all":
			return { owner: owner as string, repo: repo as string, include: { issues: true, prs: false }, state: "all" };
		case "prs:all":
			return { owner: owner as string, repo: repo as string, include: { issues: false, prs: true }, state: "all" };
		case "all":
			return { owner: owner as string, repo: repo as string, include: { issues: true, prs: true }, state: "all" };
		default:
			throw new HelpfulError({
				kind: "input_error",
				message: `unknown github-repo selector '${selector}'`,
				hint: "Selectors: issues, prs, issues:all, prs:all, all.",
			});
	}
}

/**
 * Read the GitHub token from config first, then $GITHUB_TOKEN, then
 * empty string. Empty is allowed — public repos work unauthenticated at
 * 60 req/hr; the rate-limit error path surfaces a helpful hint when we
 * blow through the budget.
 */
function resolveToken(ctx: EnumerateCtx): string {
	const downloaders = ctx.config.downloaders as unknown as Record<string, { api_key?: string }>;
	const fromConfig = (downloaders.github?.api_key ?? "").trim();
	if (fromConfig !== "") return fromConfig;
	return (process.env.GITHUB_TOKEN ?? "").trim();
}

/**
 * Walk `/repos/{owner}/{repo}/issues?state=<state>&per_page=100&page=N`
 * until a page returns fewer than 100 items. The endpoint returns both
 * issues and PRs; client-side filtering happens at the call site so
 * callers can use the same iterator for sync + enumerate.
 */
async function* paginateIssues(scope: ParsedScope, token: string): AsyncGenerator<GithubListedIssue> {
	for (let page = 1; ; page++) {
		const items = await getJson<GithubListedIssue[]>(
			`/repos/${scope.owner}/${scope.repo}/issues?state=${scope.state}&per_page=100&page=${page}`,
			token,
			`github-repo:${scope.owner}/${scope.repo}`,
		);
		for (const item of items) yield item;
		if (items.length < 100) break;
	}
}

registerSource(githubRepoPlugin);

export { githubRepoPlugin };
