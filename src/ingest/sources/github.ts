import { z } from "zod";
import { HelpfulError } from "../../errors.ts";
import { sha256Hex } from "../local-reader.ts";
import { defaultUrlHint, pluginConfig, registerSource } from "./registry.ts";
import { type BatchFetcher, type DownloadedRemote, defineSourcePlugin } from "./types.ts";

const ISSUE_OR_PR = /^\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)(?:$|\/|#|\?)/;
const API_BASE = "https://api.github.com";

const githubConfigSchema = z.object({
	api_key: z.string().meta({ secret: true }).default(""),
});

type GithubConfig = z.infer<typeof githubConfigSchema>;

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
	async enumerate(source) {
		const url = new URL(source);
		const cursor = parseIssueUrl(url);
		return [{ source: url.toString(), logicalPathHint: defaultUrlHint(url), cursor }];
	},
	rehydrateEntry(source, args) {
		const url = new URL(source);
		return { source: url.toString(), logicalPathHint: defaultUrlHint(url), cursor: args };
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
				const isPullRequest = !!issue.pull_request;
				const markdown = renderIssue(issue, comments, isPullRequest);
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

interface GithubIssue {
	number: number;
	title: string;
	body: string | null;
	state: string;
	html_url: string;
	user: { login: string } | null;
	assignees: Array<{ login: string }> | null;
	labels: Array<{ name: string } | string> | null;
	created_at: string;
	updated_at: string;
	closed_at: string | null;
	pull_request?: unknown;
}

interface GithubComment {
	body: string | null;
	user: { login: string } | null;
	created_at: string;
}

async function getJson<T>(path: string, token: string, url: URL): Promise<T> {
	const headers: Record<string, string> = {
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
		"User-Agent": "membot",
	};
	if (token !== "") headers.Authorization = `Bearer ${token}`;

	const response = await fetch(`${API_BASE}${path}`, { headers });
	if (response.status === 401 || response.status === 403) {
		throw new HelpfulError({
			kind: "auth_error",
			message: `GitHub API returned ${response.status} for ${url.toString()}.`,
			hint:
				token === ""
					? "Set a personal access token: create one at https://github.com/settings/tokens, then `membot config set downloaders.github.api_key <PAT>` (or set $GITHUB_TOKEN)."
					: "The configured API key is missing repo:read access for this repo, or has expired. Re-create the token and run `membot config set downloaders.github.api_key <PAT>`.",
		});
	}
	if (response.status === 404) {
		throw new HelpfulError({
			kind: "not_found",
			message: `GitHub returned 404 for ${url.toString()}.`,
			hint: "Verify the URL exists. Private repos require an API key with the right scope.",
		});
	}
	if (!response.ok) {
		throw new HelpfulError({
			kind: "network_error",
			message: `GitHub API returned ${response.status} ${response.statusText} for ${url.toString()}.`,
			hint: "Retry; if the failure persists, run with --verbose for the full response.",
		});
	}
	return (await response.json()) as T;
}

function renderIssue(issue: GithubIssue, comments: GithubComment[], isPr: boolean): string {
	const lines: string[] = [];
	const kind = isPr ? "PR" : "Issue";
	lines.push(`# ${kind} #${issue.number}: ${issue.title}`);
	lines.push("");
	lines.push(`- URL: ${issue.html_url}`);
	lines.push(`- State: ${issue.state}${issue.closed_at ? ` (closed ${issue.closed_at})` : ""}`);
	if (issue.user) lines.push(`- Author: @${issue.user.login}`);
	if (issue.assignees && issue.assignees.length > 0) {
		lines.push(`- Assignees: ${issue.assignees.map((a) => `@${a.login}`).join(", ")}`);
	}
	if (issue.labels && issue.labels.length > 0) {
		const labels = issue.labels.map((l) => (typeof l === "string" ? l : l.name)).filter(Boolean);
		if (labels.length > 0) lines.push(`- Labels: ${labels.join(", ")}`);
	}
	lines.push(`- Created: ${issue.created_at}`);
	lines.push(`- Updated: ${issue.updated_at}`);
	lines.push("");
	if (issue.body && issue.body.trim() !== "") {
		lines.push("## Description");
		lines.push("");
		lines.push(issue.body.trim());
		lines.push("");
	}
	if (comments.length > 0) {
		lines.push(`## Comments (${comments.length})`);
		lines.push("");
		for (const c of comments) {
			const author = c.user ? `@${c.user.login}` : "(unknown)";
			lines.push(`### ${author} — ${c.created_at}`);
			lines.push("");
			lines.push((c.body ?? "").trim());
			lines.push("");
		}
	}
	return lines.join("\n").trim();
}

registerSource(githubPlugin);

export type { GithubConfig };
export { githubConfigSchema, githubPlugin };
