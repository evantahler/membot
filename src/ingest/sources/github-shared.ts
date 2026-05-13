import matter from "gray-matter";
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

export interface GithubMilestone {
	title: string;
	due_on: string | null;
}

export interface GithubIssue {
	number: number;
	title: string;
	body: string | null;
	state: string;
	html_url: string;
	user: { login: string } | null;
	assignees: Array<{ login: string }> | null;
	labels: Array<{ name: string } | string> | null;
	milestone: GithubMilestone | null;
	draft?: boolean;
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
 * Subset of fields the timeline endpoint returns that we use to derive
 * cross-references (`references`) and closing relations (`closes`).
 * GitHub's timeline payload is large; we only type what we touch.
 *
 * - `event === "cross-referenced"` → another issue/PR linked to this one
 *   (the linking issue/PR is in `source.issue.number`).
 * - `event === "connected"` → an explicit Closes-keyword link from a PR
 *   to an issue it closes (or vice versa via `subject`/`source`).
 */
export interface GithubTimelineEvent {
	event: string;
	source?: { issue?: { number: number; pull_request?: unknown } | null } | null;
	subject?: { number?: number } | null;
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

/**
 * Render an issue or PR with comments as YAML-frontmatter-prefixed
 * markdown. Scalar metadata (state, author, assignees, labels, milestone,
 * due date, cross-references, closing relations) lives in the frontmatter
 * block at the top — both machine-parseable for agents and indexed as
 * plain text by hybrid search. The body keeps the H1 title plus the
 * Description and Comments sections.
 *
 * `timeline` is the optional `/timeline` payload; we derive `references`
 * (cross-referenced events) and, for PRs, `closes` (connected events)
 * from it. Pass an empty array when the timeline is unavailable.
 */
export function renderIssue(
	issue: GithubIssue,
	comments: GithubComment[],
	timeline: GithubTimelineEvent[],
	isPr: boolean,
): string {
	const assignees = (issue.assignees ?? []).map((a) => a.login).filter((n) => n !== "");
	const labels = (issue.labels ?? [])
		.map((l) => (typeof l === "string" ? l : l.name))
		.filter((n): n is string => typeof n === "string" && n !== "");
	const references = uniqueSorted(
		timeline.filter((e) => e.event === "cross-referenced").map((e) => e.source?.issue?.number ?? null),
	);
	const closes = isPr
		? uniqueSorted(timeline.filter((e) => e.event === "connected").map((e) => e.subject?.number ?? null))
		: [];

	const data: Record<string, unknown> = {
		source_url: issue.html_url,
		number: issue.number,
		kind: isPr ? "pull" : "issue",
		title: issue.title,
		state: issue.state,
	};
	if (isPr && typeof issue.draft === "boolean") data.draft = issue.draft;
	if (issue.user) data.author = issue.user.login;
	if (assignees.length > 0) data.assignees = assignees;
	if (labels.length > 0) data.labels = labels;
	if (issue.milestone) {
		data.milestone = issue.milestone.title;
		if (issue.milestone.due_on) data.due_date = issue.milestone.due_on;
	}
	if (references.length > 0) data.references = references;
	if (closes.length > 0) data.closes = closes;
	data.created_at = issue.created_at;
	data.updated_at = issue.updated_at;
	if (issue.closed_at) data.closed_at = issue.closed_at;

	const body = renderIssueBody(issue, comments, isPr);
	return matter.stringify(body, data).trimEnd();
}

/** Build the markdown body for an issue/PR (title heading + description + comments). */
function renderIssueBody(issue: GithubIssue, comments: GithubComment[], isPr: boolean): string {
	const lines: string[] = [];
	const kind = isPr ? "PR" : "Issue";
	lines.push(`# ${kind} #${issue.number}: ${issue.title}`);
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

/** Dedupe + drop nulls + sort ascending. Used to normalize timeline-derived issue-number lists. */
function uniqueSorted(values: Array<number | null>): number[] {
	const set = new Set<number>();
	for (const v of values) {
		if (typeof v === "number" && Number.isFinite(v)) set.add(v);
	}
	return [...set].sort((a, b) => a - b);
}
