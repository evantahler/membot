import { z } from "zod";
import { HelpfulError } from "../../errors.ts";
import { sha256Hex } from "../local-reader.ts";
import { defaultUrlHint, pluginConfig, registerSource } from "./registry.ts";
import { type BatchFetcher, type DownloadedRemote, defineSourcePlugin } from "./types.ts";

const ISSUE_PATH = /^\/([^/]+)\/issue\/([A-Z]+-\d+)(?:$|\/|#|\?)/;
const PROJECT_PATH = /^\/([^/]+)\/project\/([^/?#]+)/;
const GRAPHQL_ENDPOINT = "https://api.linear.app/graphql";

const linearConfigSchema = z.object({
	api_key: z.string().meta({ secret: true }).default(""),
});

interface LinearArgs extends Record<string, unknown> {
	kind: "issue" | "project";
	workspace: string;
	identifier?: string;
	slug?: string;
	slug_id?: string;
}

type LinearConfig = z.infer<typeof linearConfigSchema>;

/**
 * Linear's web app uses a sophisticated cookie + signed-request scheme
 * (`client-api.linear.app/graphql` with `useraccount`/`linear-client-id`
 * headers) that's not realistically replayable from outside a real
 * Linear browser session. Instead we use Linear's official API at
 * `api.linear.app/graphql` with a personal API key — set up once via
 * `membot config set downloaders.linear.api_key <KEY>` after creating
 * the key at https://linear.app/settings/api.
 */
const linearPlugin = defineSourcePlugin<LinearConfig, LinearArgs>({
	name: "linear",
	description: "Linear issues & projects — uses the Linear GraphQL API with a personal access key.",
	examples: ["https://linear.app/<workspace>/issue/<KEY>", "https://linear.app/<workspace>/project/<slug>"],
	notes:
		"Requires a personal API key from https://linear.app/settings/api. Set it via `membot config set downloaders.linear.api_key <KEY>`.",
	match: {
		kind: "url",
		matches: (url) =>
			url.hostname === "linear.app" && (ISSUE_PATH.test(url.pathname) || PROJECT_PATH.test(url.pathname)),
	},
	config: { key: "linear", schema: linearConfigSchema },
	logins: [
		{
			kind: "api_key",
			name: "Linear",
			url: "https://linear.app/settings/api",
			setupCommand: "membot config set downloaders.linear.api_key <KEY>",
			description: "create a personal API key, then run the command on the right",
		},
	],
	requiresApiKey: true,
	async enumerate(source) {
		const url = new URL(source);
		const cursor = parseLinearUrl(url);
		return [{ source: url.toString(), logicalPathHint: defaultUrlHint(url), cursor }];
	},
	rehydrateEntry(source, args) {
		const url = new URL(source);
		return { source: url.toString(), logicalPathHint: defaultUrlHint(url), cursor: args };
	},
	async openBatchFetcher(): Promise<BatchFetcher<LinearArgs>> {
		return {
			async fetch(entry, ctx): Promise<DownloadedRemote> {
				const cfg = pluginConfig(ctx, linearPlugin);
				const apiKey = cfg.api_key.trim();
				if (apiKey === "") {
					throw new HelpfulError({
						kind: "auth_error",
						message: `Linear API key not configured.`,
						hint: "Create a personal API key at https://linear.app/settings/api, then run `membot config set downloaders.linear.api_key <KEY>`.",
					});
				}
				const url = new URL(entry.source);
				const args = entry.cursor;
				let markdown: string;
				if (args.kind === "issue") {
					const identifier = args.identifier as string;
					ctx.onProgress?.(`querying issue ${identifier}`);
					const issue = await fetchIssue(identifier, apiKey, url);
					markdown = renderIssue(issue);
				} else {
					const slugId = args.slug_id as string;
					ctx.onProgress?.(`querying project ${slugId}`);
					const project = await fetchProject(slugId, apiKey, url);
					markdown = renderProject(project);
				}
				const bytes = new TextEncoder().encode(markdown);
				return {
					bytes,
					sha256: sha256Hex(bytes),
					mimeType: "text/markdown",
					downloader: "linear",
					downloaderArgs: args,
					sourceUrl: url.toString(),
				};
			},
			async close() {},
		};
	},
});

function parseLinearUrl(url: URL): LinearArgs {
	const issueMatch = url.pathname.match(ISSUE_PATH);
	if (issueMatch) {
		return { kind: "issue", workspace: issueMatch[1] as string, identifier: issueMatch[2] as string };
	}
	const projectMatch = url.pathname.match(PROJECT_PATH);
	if (projectMatch) {
		const slug = projectMatch[2] as string;
		return {
			kind: "project",
			workspace: projectMatch[1] as string,
			slug,
			slug_id: extractProjectSlugId(slug),
		};
	}
	throw new HelpfulError({
		kind: "input_error",
		message: `not a Linear issue/project URL: ${url.toString()}`,
		hint: "Pass a URL like https://linear.app/<workspace>/issue/<KEY> or .../project/<slug>.",
	});
}

interface LinearUser {
	name?: string | null;
	displayName?: string | null;
	email?: string | null;
}

interface LinearComment {
	body: string | null;
	createdAt: string | null;
	user: LinearUser | null;
}

interface LinearIssue {
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

interface LinearProject {
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

const ISSUE_QUERY = `query Issue($id: String!) {
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

const PROJECT_QUERY = `query ProjectBySlug($slugId: String!) {
  projects(filter: { slugId: { eq: $slugId } }, first: 1) {
    nodes {
      id url name slugId description content state startDate targetDate createdAt updatedAt
      lead { name displayName email }
      members(first: 50) { nodes { name displayName email } }
    }
  }
}`;

async function fetchIssue(identifier: string, apiKey: string, url: URL): Promise<LinearIssue> {
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

async function fetchProject(slugId: string, apiKey: string, url: URL): Promise<LinearProject> {
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

function extractProjectSlugId(slug: string): string {
	const match = slug.match(/-([0-9a-f]{8,})$/i);
	return match ? (match[1] as string) : slug;
}

async function graphql<T>(apiKey: string, query: string, variables: Record<string, unknown>, url: URL): Promise<T> {
	const response = await fetch(GRAPHQL_ENDPOINT, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: apiKey },
		body: JSON.stringify({ query, variables }),
	});
	if (!response.ok) {
		throw new HelpfulError({
			kind: response.status === 401 || response.status === 403 ? "auth_error" : "network_error",
			message: `Linear GraphQL returned ${response.status} ${response.statusText} for ${url.toString()}.`,
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
			message: `Linear GraphQL errors for ${url.toString()}: ${detail}`,
			hint: "Verify the URL is correct and the API key has visibility into the workspace.",
		});
	}
	if (!json.data) {
		throw new HelpfulError({
			kind: "internal_error",
			message: `Linear GraphQL returned no data for ${url.toString()}.`,
			hint: "Re-run with `--verbose` and report the response shape.",
		});
	}
	return json.data;
}

function renderIssue(issue: LinearIssue): string {
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

function renderProject(project: LinearProject): string {
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

function userLabel(user: LinearUser): string {
	const name = user.displayName ?? user.name ?? "(unknown)";
	if (user.email) return `${name} <${user.email}>`;
	return name;
}

registerSource(linearPlugin);

export type { LinearConfig };
export { linearConfigSchema, linearPlugin };
