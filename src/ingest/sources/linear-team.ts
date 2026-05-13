import { listCurrent, tombstone } from "../../db/files.ts";
import { HelpfulError } from "../../errors.ts";
import { sha256Hex } from "../local-reader.ts";
import {
	fetchIssue,
	fetchProject,
	graphql,
	type LinearConfig,
	linearConfigSchema,
	linearIssuePath,
	linearProjectPath,
	renderIssue,
	renderProject,
} from "./linear-shared.ts";
import { pluginConfig, registerSource } from "./registry.ts";
import {
	type BatchFetcher,
	type DownloadedRemote,
	defineSourcePlugin,
	type Entry,
	type EnumerateCtx,
} from "./types.ts";

const TEAM_SCHEME = "linear-team:";
const TEAM_KEY_RE = /^[A-Z][A-Z0-9_]*$/;

interface LinearTeamIssueArgs extends Record<string, unknown> {
	kind: "issue";
	team: string;
	workspace: string;
	identifier: string;
}

interface LinearTeamProjectArgs extends Record<string, unknown> {
	kind: "project";
	team: string;
	workspace: string;
	slug: string;
	slug_id: string;
	project_id: string;
}

type LinearTeamArgs = LinearTeamIssueArgs | LinearTeamProjectArgs;

interface TeamRef {
	id: string;
	key: string;
}

interface TeamNode extends TeamRef {
	organization: { urlKey: string } | null;
}

interface ProjectNode {
	id: string;
	name: string;
	slugId: string;
	url: string;
	updatedAt: string;
}

interface IssueNode {
	id: string;
	identifier: string;
	title: string;
	url: string;
	updatedAt: string;
}

interface PageInfo {
	hasNextPage: boolean;
	endCursor: string | null;
}

const TEAM_BY_KEY_QUERY = `query TeamByKey($key: String!) {
  teams(filter: { key: { eq: $key } }, first: 1) {
    nodes {
      id key
      organization { urlKey }
    }
  }
}`;

/**
 * Sub-team lookup via the `parent` filter — confirmed to exist on Linear's
 * TeamFilter. We avoid `Team.children` because not every Linear schema
 * version exposes that connection field, and the parent-filter form works
 * uniformly. Pagination shouldn't be needed in practice (teams rarely have
 * more than 100 direct children), but we paginate defensively.
 */
const SUB_TEAMS_QUERY = `query SubTeams($parentId: ID!, $after: String) {
  teams(filter: { parent: { id: { eq: $parentId } } }, first: 100, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { id key }
  }
}`;

const PROJECTS_FOR_TEAM_QUERY = `query ProjectsForTeam($teamId: ID!, $after: String) {
  projects(filter: { accessibleTeams: { some: { id: { eq: $teamId } } } },
           first: 50, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { id name slugId url updatedAt }
  }
}`;

/**
 * Issues belong to exactly one team via `Issue.team`, so we walk
 * `team(id).issues` once per team instead of querying issues per project
 * — much cheaper for teams with many small projects. Each issue cursor
 * already carries `identifier`, which is enough for refresh.
 */
const ISSUES_FOR_TEAM_QUERY = `query IssuesForTeam($teamId: String!, $after: String) {
  team(id: $teamId) {
    issues(first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { id identifier title url updatedAt }
    }
  }
}`;

/**
 * Linear team bulk import. Enumerates every project visible to the team
 * plus every issue inside those projects, yielding one Entry per item.
 * Source URI shape: `linear-team:<TEAM_KEY>` where the key is the
 * uppercase prefix shared by issue identifiers in that team (e.g. `ENG`
 * from `ENG-42`).
 *
 * Shares the per-URL Linear plugin's API-key config slice
 * (`downloaders.linear.api_key`) and its fetch + render code. Refresh of
 * a single ingested row re-fetches one issue or project — never
 * re-enumerates the whole team. `--sync` does the reconcile.
 */
const linearTeamPlugin = defineSourcePlugin<LinearConfig, LinearTeamArgs>({
	name: "linear-team",
	description:
		"Linear team bulk import — every project under a team plus every issue in those projects, via the Linear GraphQL API.",
	examples: ["linear-team:ENG", "linear-team:DESIGN"],
	notes:
		"Same API key as the per-URL linear plugin (`membot config set downloaders.linear.api_key <KEY>`). Team key is the uppercase prefix of issue IDs (e.g. ENG from ENG-42). Pass --sync to tombstone projects/issues that have been deleted from Linear.",
	match: { kind: "scheme", prefix: TEAM_SCHEME },
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
	async enumerate(source, ctx) {
		const { team } = parseLinearTeamScope(source);
		const apiKey = requireApiKey(ctx);
		const { workspace, teamIds, childKeys } = await resolveTeamHierarchy(apiKey, team, source);

		const subTeamSuffix = childKeys.length > 0 ? ` (incl. sub-teams: ${childKeys.join(", ")})` : "";
		ctx.logger.info(`linear-team:${team}: enumerating across ${teamIds.length} team(s)${subTeamSuffix}`);

		const entries: Entry<LinearTeamArgs>[] = [];
		const seenProjects = new Set<string>();
		for (const teamId of teamIds) {
			for await (const project of paginate(
				apiKey,
				PROJECTS_FOR_TEAM_QUERY,
				{ teamId },
				source,
				(data: { projects: { pageInfo: PageInfo; nodes: ProjectNode[] } }) => data.projects,
			)) {
				// A project shared across parent + sub-team comes back from
				// multiple per-team queries — dedupe so we don't double-ingest.
				if (seenProjects.has(project.id)) continue;
				seenProjects.add(project.id);
				entries.push({
					source: project.url,
					logicalPathHint: linearProjectPath(workspace, project.slugId),
					mtimeMs: Date.parse(project.updatedAt),
					cursor: {
						kind: "project",
						team,
						workspace,
						slug: project.slugId,
						slug_id: project.slugId,
						project_id: project.id,
					} satisfies LinearTeamProjectArgs,
				});
			}
		}
		ctx.logger.info(`linear-team:${team}: found ${seenProjects.size} project(s); enumerating issues per team`);

		// Issues belong to exactly one team, so iterating teams won't double-count.
		// Pull issues per team via `team.issues` — one paginated walk per team.
		let issueCount = 0;
		for (const teamId of teamIds) {
			for await (const issue of paginate(
				apiKey,
				ISSUES_FOR_TEAM_QUERY,
				{ teamId },
				source,
				(data: { team: { issues: { pageInfo: PageInfo; nodes: IssueNode[] } } | null }) =>
					data.team?.issues ?? { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
			)) {
				entries.push({
					source: issue.url,
					logicalPathHint: linearIssuePath(workspace, issue.identifier),
					mtimeMs: Date.parse(issue.updatedAt),
					cursor: {
						kind: "issue",
						team,
						workspace,
						identifier: issue.identifier,
					} satisfies LinearTeamIssueArgs,
				});
				issueCount += 1;
				if (issueCount % 500 === 0) {
					ctx.logger.info(`linear-team:${team}: ${issueCount} issues enumerated so far…`);
				}
			}
		}
		ctx.logger.info(
			`linear-team:${team}: enumerated ${entries.length} entries (${seenProjects.size} projects + ${issueCount} issues)`,
		);
		return entries;
	},
	rehydrateEntry(source, args) {
		const hint =
			args.kind === "issue"
				? linearIssuePath(args.workspace, args.identifier)
				: linearProjectPath(args.workspace, args.slug);
		return { source, logicalPathHint: hint, cursor: args };
	},
	probeUnchanged(entry, persisted) {
		if (entry.mtimeMs === undefined || persisted.source_mtime_ms === null) return false;
		return entry.mtimeMs === persisted.source_mtime_ms;
	},
	async openBatchFetcher(): Promise<BatchFetcher<LinearTeamArgs>> {
		return {
			async fetch(entry, ctx): Promise<DownloadedRemote> {
				const cfg = pluginConfig(ctx, linearTeamPlugin);
				const apiKey = cfg.api_key.trim();
				if (apiKey === "") {
					throw new HelpfulError({
						kind: "auth_error",
						message: `Linear API key not configured.`,
						hint: "Create a personal API key at https://linear.app/settings/api, then run `membot config set downloaders.linear.api_key <KEY>`.",
					});
				}
				const args = entry.cursor;
				let markdown: string;
				if (args.kind === "issue") {
					ctx.onProgress?.(`querying issue ${args.identifier}`);
					const issue = await fetchIssue(args.identifier, apiKey, entry.source);
					markdown = renderIssue(issue);
				} else {
					ctx.onProgress?.(`querying project ${args.slug_id}`);
					const project = await fetchProject(args.slug_id, apiKey, entry.source);
					markdown = renderProject(project);
				}
				const bytes = new TextEncoder().encode(markdown);
				return {
					bytes,
					sha256: sha256Hex(bytes),
					mimeType: "text/markdown",
					downloader: "linear-team",
					downloaderArgs: args,
					sourceUrl: entry.source,
				};
			},
			async close() {},
		};
	},
	async sync(ctx, source) {
		const { team } = parseLinearTeamScope(source);
		const apiKey = requireApiKey({ config: ctx.config, logger: ctx.logger });
		const { workspace, teamIds } = await resolveTeamHierarchy(apiKey, team, source);
		const liveIssueIdentifiers = new Set<string>();
		const liveProjectSlugIds = new Set<string>();
		const seenProjects = new Set<string>();
		for (const teamId of teamIds) {
			for await (const project of paginate(
				apiKey,
				PROJECTS_FOR_TEAM_QUERY,
				{ teamId },
				source,
				(data: { projects: { pageInfo: PageInfo; nodes: ProjectNode[] } }) => data.projects,
			)) {
				if (seenProjects.has(project.id)) continue;
				seenProjects.add(project.id);
				liveProjectSlugIds.add(project.slugId);
			}
			for await (const issue of paginate(
				apiKey,
				ISSUES_FOR_TEAM_QUERY,
				{ teamId },
				source,
				(data: { team: { issues: { pageInfo: PageInfo; nodes: IssueNode[] } } | null }) =>
					data.team?.issues ?? { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
			)) {
				liveIssueIdentifiers.add(issue.identifier);
			}
		}

		const prefix = workspace !== "" ? `linear/${workspace.toLowerCase()}/` : "linear/";
		const rows = await listCurrent(ctx.db, { prefix, limit: 100_000 });
		const tombstoned: string[] = [];
		for (const row of rows) {
			if (row.downloader !== "linear-team") continue;
			const args = (row.downloader_args ?? {}) as Record<string, unknown>;
			if (args.team !== team) continue;
			if (args.kind === "issue") {
				const id = args.identifier;
				if (typeof id !== "string") continue;
				if (liveIssueIdentifiers.has(id)) continue;
				await tombstone(ctx.db, row.logical_path, `sync: ${id} deleted from Linear`);
				tombstoned.push(row.logical_path);
			} else if (args.kind === "project") {
				const slugId = args.slug_id;
				if (typeof slugId !== "string") continue;
				if (liveProjectSlugIds.has(slugId)) continue;
				await tombstone(ctx.db, row.logical_path, `sync: project ${slugId} deleted from Linear`);
				tombstoned.push(row.logical_path);
			}
		}
		return { tombstoned };
	},
});

/**
 * Parse the `linear-team:<KEY>` scheme into its team component. Throws
 * HelpfulError with a concrete hint when the key is missing or malformed.
 */
export function parseLinearTeamScope(source: string): { team: string } {
	if (!source.startsWith(TEAM_SCHEME)) {
		throw new HelpfulError({
			kind: "input_error",
			message: `not a linear-team source: ${source}`,
			hint: "Pass a source like `linear-team:ENG`.",
		});
	}
	const key = source.slice(TEAM_SCHEME.length);
	if (key === "") {
		throw new HelpfulError({
			kind: "input_error",
			message: "linear-team source has no team key",
			hint: "Pass a source like `linear-team:ENG` — the key is the uppercase prefix of issue IDs.",
		});
	}
	if (!TEAM_KEY_RE.test(key)) {
		throw new HelpfulError({
			kind: "input_error",
			message: `invalid linear-team key '${key}' — must be uppercase ASCII letters/digits/underscores starting with a letter`,
			hint: "Linear team keys look like `ENG`, `DESIGN`, `INFRA_2`. Check the prefix of any issue ID in your team.",
		});
	}
	return { team: key };
}

/**
 * Resolve the team by key and pull in its direct sub-teams. Linear's
 * `accessibleTeams` filter isn't transitive across parent/child, so to
 * cover projects owned only by sub-teams we discover children via the
 * `parent` filter and run the projects query against each team id
 * separately (deduping the union at the call site).
 *
 * Walks one level only — recurse here if we ever see deeper team trees
 * in the wild.
 */
async function resolveTeamHierarchy(
	apiKey: string,
	teamKey: string,
	ref: string,
): Promise<{ workspace: string; teamIds: string[]; childKeys: string[] }> {
	const res = await graphql<{ teams: { nodes: TeamNode[] } }>(apiKey, TEAM_BY_KEY_QUERY, { key: teamKey }, ref);
	const teamNode = res.teams.nodes[0];
	if (!teamNode) {
		throw new HelpfulError({
			kind: "not_found",
			message: `Linear has no team with key ${teamKey} visible to this API key.`,
			hint: "Check the team key (the prefix used in issue IDs, e.g. ENG from ENG-42) and that the API key has access to that team's workspace.",
		});
	}
	const workspace = teamNode.organization?.urlKey ?? "";
	if (workspace === "") {
		throw new HelpfulError({
			kind: "internal_error",
			message: `Linear team ${teamKey} has no organization urlKey.`,
			hint: "Open an issue in the membot repo with the team key — Linear's API didn't return the expected organization metadata.",
		});
	}
	const children: TeamRef[] = [];
	for await (const child of paginate(
		apiKey,
		SUB_TEAMS_QUERY,
		{ parentId: teamNode.id },
		ref,
		(data: { teams: { pageInfo: PageInfo; nodes: TeamRef[] } }) => data.teams,
	)) {
		children.push(child);
	}
	const teamIds = [teamNode.id, ...children.map((c) => c.id)];
	const childKeys = children.map((c) => c.key);
	return { workspace, teamIds, childKeys };
}

/**
 * Read the API key from the plugin's config slice. Throws an
 * `auth_error` HelpfulError with a concrete next step when missing —
 * same error shape both enumerate and sync raise on the path.
 */
function requireApiKey(ctx: EnumerateCtx): string {
	const downloaders = ctx.config.downloaders as unknown as Record<string, { api_key?: string }>;
	const fromConfig = (downloaders.linear?.api_key ?? "").trim();
	if (fromConfig !== "") return fromConfig;
	throw new HelpfulError({
		kind: "auth_error",
		message: "Linear API key not configured.",
		hint: "Create a personal API key at https://linear.app/settings/api, then run `membot config set downloaders.linear.api_key <KEY>`.",
	});
}

/**
 * Walk a paginated GraphQL connection. `extract` pulls the
 * `{ pageInfo, nodes }` shape out of each response so callers don't
 * repeat the boilerplate. Yields one node at a time so consumers can
 * stream without materializing the full list in memory first.
 */
async function* paginate<TData, TNode>(
	apiKey: string,
	query: string,
	baseVars: Record<string, unknown>,
	ref: URL | string,
	extract: (data: TData) => { pageInfo: PageInfo; nodes: TNode[] },
): AsyncGenerator<TNode> {
	let cursor: string | null = null;
	while (true) {
		const data = await graphql<TData>(apiKey, query, { ...baseVars, after: cursor }, ref);
		const { pageInfo, nodes } = extract(data);
		for (const node of nodes) yield node;
		if (!pageInfo.hasNextPage || !pageInfo.endCursor) break;
		cursor = pageInfo.endCursor;
	}
}

registerSource(linearTeamPlugin);

export { linearTeamPlugin };
