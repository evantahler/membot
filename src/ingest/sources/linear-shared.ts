import { z } from "zod";
import { HelpfulError } from "../../errors.ts";

/**
 * Shared Linear primitives: the GraphQL client, single-item fetchers,
 * markdown renderers, and the canonical `logical_path` builders. Lifted
 * out of `linear.ts` so the bulk-import plugin `linear-team.ts` can reuse
 * the same fetch + render path the per-URL plugin uses. Path builders
 * live here so both plugins land identical items at identical paths.
 */

export const GRAPHQL_ENDPOINT = "https://api.linear.app/graphql";

export const linearConfigSchema = z.object({
	api_key: z.string().meta({ secret: true }).default(""),
});
export type LinearConfig = z.infer<typeof linearConfigSchema>;

export interface LinearUser {
	name?: string | null;
	displayName?: string | null;
	email?: string | null;
}

export interface LinearComment {
	body: string | null;
	createdAt: string | null;
	user: LinearUser | null;
}

export interface LinearIssue {
	identifier: string;
	url: string;
	title: string;
	description: string | null;
	priorityLabel: string | null;
	state: { name: string } | null;
	assignee: LinearUser | null;
	creator: LinearUser | null;
	createdAt: string;
	updatedAt: string;
	comments: { nodes: LinearComment[] };
}

export interface LinearProject {
	id: string;
	url: string;
	name: string;
	slugId: string;
	description: string | null;
	content: string | null;
	state: string | null;
	startDate: string | null;
	targetDate: string | null;
	createdAt: string;
	updatedAt: string;
	lead: LinearUser | null;
	members: { nodes: LinearUser[] };
}

export const ISSUE_QUERY = `query Issue($id: String!) {
  issue(id: $id) {
    identifier url title description priorityLabel
    state { name }
    assignee { name displayName email }
    creator { name displayName email }
    createdAt updatedAt
    comments(first: 100) {
      nodes { body createdAt user { name displayName email } }
    }
  }
}`;

export const PROJECT_QUERY = `query ProjectBySlug($slugId: String!) {
  projects(filter: { slugId: { eq: $slugId } }, first: 1) {
    nodes {
      id url name slugId description content state startDate targetDate createdAt updatedAt
      lead { name displayName email }
      members(first: 50) { nodes { name displayName email } }
    }
  }
}`;

/**
 * Logical path for a Linear issue. Same shape regardless of whether the
 * issue was added by URL or by bulk team import — `linear/<workspace>/issues/<KEY>.md`.
 */
export function linearIssuePath(workspace: string, identifier: string): string {
	return `linear/${workspace.toLowerCase()}/issues/${identifier}.md`;
}

/**
 * Logical path for a Linear project. Same shape for URL and bulk paths.
 * `slug` is Linear's full slug (`my-project-abcd1234`), which already
 * carries an 8-hex disambiguator so two projects with the same name
 * cannot collide.
 */
export function linearProjectPath(workspace: string, slug: string): string {
	return `linear/${workspace.toLowerCase()}/projects/${slug}.md`;
}

/**
 * Extract the 8-hex `slug_id` Linear uses to disambiguate project URLs.
 * A project URL looks like `/project/my-project-abcd1234`; `slug_id` is
 * the trailing hex run. Falls back to the whole slug when no suffix is
 * present (rare, used for legacy URLs).
 */
export function extractProjectSlugId(slug: string): string {
	const match = slug.match(/-([0-9a-f]{8,})$/i);
	return match ? (match[1] as string) : slug;
}

/**
 * Issue one Linear GraphQL request with a sensible error envelope. The
 * `url` argument is purely diagnostic — it shows up in HelpfulError
 * messages so users see which source triggered the failure.
 */
export async function graphql<T>(
	apiKey: string,
	query: string,
	variables: Record<string, unknown>,
	url: URL | string,
): Promise<T> {
	const response = await fetch(GRAPHQL_ENDPOINT, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: apiKey },
		body: JSON.stringify({ query, variables }),
	});
	const ref = typeof url === "string" ? url : url.toString();
	if (!response.ok) {
		throw new HelpfulError({
			kind: response.status === 401 || response.status === 403 ? "auth_error" : "network_error",
			message: `Linear GraphQL returned ${response.status} ${response.statusText} for ${ref}.`,
			hint:
				response.status === 401 || response.status === 403
					? "Re-create the API key at https://linear.app/settings/api and run `membot config set downloaders.linear.api_key <KEY>`."
					: "Check that the URL is reachable and that the API key has access to the issue/project.",
		});
	}
	const json = (await response.json()) as { data?: T; errors?: Array<{ message: string }> };
	if (json.errors && json.errors.length > 0) {
		const detail = json.errors.map((e) => e.message).join("; ");
		throw new HelpfulError({
			kind: "input_error",
			message: `Linear GraphQL errors for ${ref}: ${detail}`,
			hint: "Verify the URL is correct and the API key has visibility into the workspace.",
		});
	}
	if (!json.data) {
		throw new HelpfulError({
			kind: "internal_error",
			message: `Linear GraphQL returned no data for ${ref}.`,
			hint: "Re-run with `--verbose` and report the response shape.",
		});
	}
	return json.data;
}

/** Fetch one issue by `identifier` (e.g. `ENG-42`). 404 → HelpfulError not_found. */
export async function fetchIssue(identifier: string, apiKey: string, url: URL | string): Promise<LinearIssue> {
	const result = await graphql<{ issue: LinearIssue | null }>(apiKey, ISSUE_QUERY, { id: identifier }, url);
	if (!result.issue) {
		throw new HelpfulError({
			kind: "not_found",
			message: `Linear has no issue ${identifier} visible to this API key.`,
			hint: "Verify the URL exists and that the API key belongs to a member of the issue's workspace.",
		});
	}
	return result.issue;
}

/** Fetch one project by `slug_id`. 404 → HelpfulError not_found. */
export async function fetchProject(slugId: string, apiKey: string, url: URL | string): Promise<LinearProject> {
	const result = await graphql<{ projects: { nodes: LinearProject[] } }>(apiKey, PROJECT_QUERY, { slugId }, url);
	const project = result.projects.nodes[0];
	if (!project) {
		throw new HelpfulError({
			kind: "not_found",
			message: `Linear has no project with slug ${slugId} visible to this API key.`,
			hint: "Verify the URL exists and that the API key belongs to a member of the project's workspace.",
		});
	}
	return project;
}

/** Render a Linear user reference as `Name <email>` (or just name when no email). */
export function userLabel(user: LinearUser): string {
	const name = user.displayName ?? user.name ?? "(unknown)";
	if (user.email) return `${name} <${user.email}>`;
	return name;
}

/** Render an issue payload as the markdown body that flows into chunk/embed. */
export function renderIssue(issue: LinearIssue): string {
	const lines: string[] = [];
	lines.push(`# ${issue.identifier}: ${issue.title}`);
	lines.push("");
	lines.push(`- URL: ${issue.url}`);
	if (issue.state) lines.push(`- Status: ${issue.state.name}`);
	if (issue.priorityLabel) lines.push(`- Priority: ${issue.priorityLabel}`);
	if (issue.assignee) lines.push(`- Assignee: ${userLabel(issue.assignee)}`);
	if (issue.creator) lines.push(`- Author: ${userLabel(issue.creator)}`);
	lines.push(`- Created: ${issue.createdAt}`);
	lines.push(`- Updated: ${issue.updatedAt}`);
	lines.push("");
	if (issue.description) {
		lines.push("## Description");
		lines.push("");
		lines.push(issue.description.trim());
		lines.push("");
	}
	const comments = issue.comments.nodes;
	if (comments.length > 0) {
		lines.push(`## Comments (${comments.length})`);
		lines.push("");
		for (const c of comments) {
			const who = c.user ? userLabel(c.user) : "(unknown)";
			lines.push(`### ${who} — ${c.createdAt ?? ""}`);
			lines.push("");
			lines.push((c.body ?? "").trim());
			lines.push("");
		}
	}
	return lines.join("\n").trim();
}

/** Render a project payload as the markdown body that flows into chunk/embed. */
export function renderProject(project: LinearProject): string {
	const lines: string[] = [];
	lines.push(`# ${project.name}`);
	lines.push("");
	lines.push(`- URL: ${project.url}`);
	if (project.state) lines.push(`- State: ${project.state}`);
	if (project.startDate) lines.push(`- Start: ${project.startDate}`);
	if (project.targetDate) lines.push(`- Target: ${project.targetDate}`);
	if (project.lead) lines.push(`- Lead: ${userLabel(project.lead)}`);
	const members = project.members.nodes;
	if (members.length > 0) lines.push(`- Members: ${members.map(userLabel).join(", ")}`);
	lines.push(`- Created: ${project.createdAt}`);
	lines.push(`- Updated: ${project.updatedAt}`);
	lines.push("");
	if (project.description) {
		lines.push("## Summary");
		lines.push("");
		lines.push(project.description.trim());
		lines.push("");
	}
	if (project.content) {
		lines.push("## Overview");
		lines.push("");
		lines.push(project.content.trim());
		lines.push("");
	}
	return lines.join("\n").trim();
}
