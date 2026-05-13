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
import { type BatchFetcher, type DownloadedRemote, defineSourcePlugin } from "./types.ts";

const ISSUE_OR_PR = /^\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)(?:$|\/|#|\?)/;

interface GithubArgs extends Record<string, unknown> {
	owner: string;
	repo: string;
	kind: "issues" | "pull";
	number: number;
}

/**
 * GitHub issues and PRs via the REST API. The user sets a personal
 * access token once via `membot config set downloaders.github.api_key
 * <PAT>` (or via the `GITHUB_TOKEN` env var). We fetch the issue/PR +
 * every comment as structured JSON, then render to markdown.
 *
 * Public repos: the `api_key` is optional — unauthenticated requests
 * work but get rate-limited at 60 req/hr. Private repos require it.
 */
const githubPlugin = defineSourcePlugin<GithubConfig, GithubArgs>({
	name: "github",
	description: "GitHub issues & PRs — uses the GitHub REST API (with optional token for private repos).",
	examples: ["https://github.com/<owner>/<repo>/issues/<n>", "https://github.com/<owner>/<repo>/pull/<n>"],
	notes:
		"Public repos work unauthenticated at 60 req/hr. For private repos or higher limits, configure a token: `membot config set downloaders.github.api_key <PAT>` or export `GITHUB_TOKEN`.",
	match: {
		kind: "url",
		matches: (url) => url.hostname === "github.com" && ISSUE_OR_PR.test(url.pathname),
	},
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
	async enumerate(source, _ctx) {
		const url = new URL(source);
		const cursor = parseIssueUrl(url);
		return [
			{
				source: url.toString(),
				logicalPathHint: githubIssuePath(cursor.owner, cursor.repo, cursor.kind, cursor.number),
				cursor,
			},
		];
	},
	rehydrateEntry(source, args) {
		const url = new URL(source);
		return {
			source: url.toString(),
			logicalPathHint: githubIssuePath(args.owner, args.repo, args.kind, args.number),
			cursor: args,
		};
	},
	async openBatchFetcher(): Promise<BatchFetcher<GithubArgs>> {
		return {
			async fetch(entry, ctx): Promise<DownloadedRemote> {
				const cfg = pluginConfig(ctx, githubPlugin);
				const token = (cfg.api_key || process.env.GITHUB_TOKEN || "").trim();
				const { owner, repo, number } = entry.cursor;
				const url = new URL(entry.source);
				ctx.onProgress?.("fetching issue");
				const issue = await getJson<GithubIssue>(`/repos/${owner}/${repo}/issues/${number}`, token, url);
				ctx.onProgress?.("fetching comments");
				const comments = await getJson<GithubComment[]>(
					`/repos/${owner}/${repo}/issues/${number}/comments?per_page=100`,
					token,
					url,
				);
				ctx.onProgress?.("fetching timeline");
				const timeline = await getJson<GithubTimelineEvent[]>(
					`/repos/${owner}/${repo}/issues/${number}/timeline?per_page=100`,
					token,
					url,
				);
				const isPullRequest = !!issue.pull_request;
				const markdown = renderIssue(issue, comments, timeline, isPullRequest);
				const bytes = new TextEncoder().encode(markdown);
				return {
					bytes,
					sha256: sha256Hex(bytes),
					mimeType: "text/markdown",
					downloader: "github",
					downloaderArgs: entry.cursor,
					sourceUrl: url.toString(),
				};
			},
			async close() {},
		};
	},
});

/**
 * Parse a `github.com/<owner>/<repo>/issues|pull/<n>` URL into the cursor
 * shape both `enumerate` and refresh use. Throws HelpfulError when the
 * URL doesn't match.
 */
function parseIssueUrl(url: URL): GithubArgs {
	const match = url.pathname.match(ISSUE_OR_PR);
	if (!match) {
		throw new HelpfulError({
			kind: "input_error",
			message: `not a GitHub issue/PR URL: ${url.toString()}`,
			hint: "Pass a URL like https://github.com/<owner>/<repo>/issues/<n> or .../pull/<n>.",
		});
	}
	return {
		owner: match[1] as string,
		repo: match[2] as string,
		kind: match[3] as "issues" | "pull",
		number: Number(match[4]),
	};
}

registerSource(githubPlugin);

export type { GithubConfig };
export { githubConfigSchema, githubPlugin };
