import { HelpfulError } from "../../errors.ts";
import { sha256Hex } from "../local-reader.ts";
import {
	extractProjectSlugId,
	fetchIssue,
	fetchProject,
	type LinearConfig,
	linearConfigSchema,
	linearIssuePath,
	linearProjectPath,
	renderIssue,
	renderProject,
} from "./linear-shared.ts";
import { pluginConfig, registerSource } from "./registry.ts";
import { type BatchFetcher, type DownloadedRemote, defineSourcePlugin } from "./types.ts";

const ISSUE_PATH = /^\/([^/]+)\/issue\/([A-Z]+-\d+)(?:$|\/|#|\?)/;
const PROJECT_PATH = /^\/([^/]+)\/project\/([^/?#]+)/;

interface LinearArgs extends Record<string, unknown> {
	kind: "issue" | "project";
	workspace: string;
	identifier?: string;
	slug?: string;
	slug_id?: string;
}

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
	async enumerate(source, _ctx) {
		const url = new URL(source);
		const cursor = parseLinearUrl(url);
		const hint =
			cursor.kind === "issue"
				? linearIssuePath(cursor.workspace, cursor.identifier as string)
				: linearProjectPath(cursor.workspace, cursor.slug as string);
		return [{ source: url.toString(), logicalPathHint: hint, cursor }];
	},
	rehydrateEntry(source, args) {
		const url = new URL(source);
		const hint =
			args.kind === "issue"
				? linearIssuePath(args.workspace, args.identifier as string)
				: linearProjectPath(args.workspace, args.slug as string);
		return { source: url.toString(), logicalPathHint: hint, cursor: args };
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

/**
 * Parse a Linear URL into the cursor shape both `enumerate` and refresh
 * use. Throws HelpfulError when the URL isn't an issue/project URL.
 */
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

registerSource(linearPlugin);

export type { LinearConfig };
export { linearConfigSchema, linearPlugin };
