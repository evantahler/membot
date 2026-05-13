import { z } from "zod";
import { HelpfulError } from "../../errors.ts";

/**
 * Shared GitHub primitives: REST GET helper, markdown renderer, and the
 * canonical `logical_path` builder. Lifted out of `github.ts` so the
 * bulk-import plugin `github-repo.ts` can reuse the same fetch + render
 * path and so both plugins land identical items at identical paths.
 */

export const API_BASE = "https://api.github.com";

export const githubConfigSchema = z.object({
	api_key: z.string().meta({ secret: true }).default(""),
});
export type GithubConfig = z.infer<typeof githubConfigSchema>;

export interface GithubIssue {
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

export interface GithubComment {
	body: string | null;
	user: { login: string } | null;
	created_at: string;
}

/**
 * Logical path for a GitHub issue or PR. Same shape regardless of how it
 * was ingested — `github/<owner>/<repo>/issues/<n>.md` for issues,
 * `github/<owner>/<repo>/pulls/<n>.md` for PRs (note the plural; URLs
 * say `/pull/<n>` singular but we mirror the REST resource name).
 */
export function githubIssuePath(owner: string, repo: string, kind: "issues" | "pull", number: number): string {
	const segment = kind === "pull" ? "pulls" : "issues";
	return `github/${owner.toLowerCase()}/${repo.toLowerCase()}/${segment}/${number}.md`;
}

/**
 * GET a GitHub REST endpoint with authentication and the standard
 * `X-GitHub-Api-Version` header. `url` is for diagnostics only. 401/403
 * surface as `auth_error`; 404 as `not_found`; 403 with
 * `X-RateLimit-Remaining: 0` is treated as a rate-limit by callers that
 * want to special-case it.
 */
export async function getJson<T>(path: string, token: string, url: URL | string): Promise<T> {
	const headers: Record<string, string> = {
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
		"User-Agent": "membot",
	};
	if (token !== "") headers.Authorization = `Bearer ${token}`;

	const ref = typeof url === "string" ? url : url.toString();
	const response = await fetch(`${API_BASE}${path}`, { headers });
	if (response.status === 401 || response.status === 403) {
		const remaining = response.headers.get("x-ratelimit-remaining");
		const reset = response.headers.get("x-ratelimit-reset");
		if (response.status === 403 && remaining === "0") {
			const resetDate = reset ? new Date(Number(reset) * 1000).toISOString() : "unknown";
			throw new HelpfulError({
				kind: "network_error",
				message: `GitHub rate-limit hit for ${ref} (resets at ${resetDate}).`,
				hint:
					token === ""
						? "Public unauthenticated calls cap at 60/hr. Configure a token: create one at https://github.com/settings/tokens, then `membot config set downloaders.github.api_key <PAT>` (or export $GITHUB_TOKEN)."
						: `Wait until ${resetDate} or use a token with a higher rate limit (GitHub Apps / fine-grained PATs typically get 5000/hr).`,
			});
		}
		throw new HelpfulError({
			kind: "auth_error",
			message: `GitHub API returned ${response.status} for ${ref}.`,
			hint:
				token === ""
					? "Set a personal access token: create one at https://github.com/settings/tokens, then `membot config set downloaders.github.api_key <PAT>` (or set $GITHUB_TOKEN)."
					: "The configured API key is missing repo:read access for this repo, or has expired. Re-create the token and run `membot config set downloaders.github.api_key <PAT>`.",
		});
	}
	if (response.status === 404) {
		throw new HelpfulError({
			kind: "not_found",
			message: `GitHub returned 404 for ${ref}.`,
			hint: "Verify the URL exists. Private repos require an API key with the right scope.",
		});
	}
	if (!response.ok) {
		throw new HelpfulError({
			kind: "network_error",
			message: `GitHub API returned ${response.status} ${response.statusText} for ${ref}.`,
			hint: "Retry; if the failure persists, run with --verbose for the full response.",
		});
	}
	return (await response.json()) as T;
}

/** Render an issue or PR with comments as the markdown body that flows into chunk/embed. */
export function renderIssue(issue: GithubIssue, comments: GithubComment[], isPr: boolean): string {
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
