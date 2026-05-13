import { z } from "zod";
import { listSources } from "../ingest/sources/registry.ts";
import { colors } from "../output/formatter.ts";
import { defineOperation } from "./types.ts";

/**
 * One row in the registered-plugins list. Surfaced to both humans
 * (`membot sources`) and agents (`membot_sources` MCP tool) so a caller
 * can discover what `membot add` will accept before throwing a URL at it.
 */
const SourceRowSchema = z.object({
	name: z.string().describe("Stable id; persisted as `files.downloader` and accepted by `--downloader`."),
	description: z.string().describe("One-line LLM/human description of the plugin."),
	notes: z.string().nullable().describe("Optional longer caveat (rate limits, platform requirements)."),
	match_kind: z.enum(["url", "scheme"]).describe("How the plugin claims input."),
	scheme: z
		.string()
		.nullable()
		.describe("For scheme-kind plugins, the URI prefix (e.g. `apple-notes:`). null for URL plugins."),
	auth_kind: z
		.enum(["api_key", "none"])
		.describe("`api_key` = needs a token set via `membot config set`. `none` = no auth."),
	requires_api_key: z
		.boolean()
		.describe("True when this plugin's auth_error needs a token set via `membot config set`."),
	platform: z.array(z.string()).nullable().describe("Platforms this plugin is registered on. null = all platforms."),
	examples: z.array(z.string()).describe("Concrete example sources users can copy-paste."),
});

export const sourcesOperation = defineOperation({
	name: "membot_sources",
	cliName: "sources",
	description: `List every registered source plugin — what URL or scheme each one claims, what authentication it needs, and concrete example inputs.

Call this BEFORE \`membot_add\` when you're not sure what shape of input is supported. The output is generated from the live plugin registry so adding a new source automatically shows up here.

When \`auth_kind\` is \`api_key\`, the credential lives in \`~/.membot/config.json\` under \`downloaders.<plugin>.api_key\` — point the user at \`membot config set\` to fix.`,
	inputSchema: z.object({}),
	outputSchema: z.object({
		sources: z.array(SourceRowSchema),
		total: z.number(),
	}),
	console_formatter: (result) => {
		const lines: string[] = [];
		for (const row of result.sources) {
			const head = `${colors.cyan(row.name)} ${colors.dim(`[${row.match_kind}${row.scheme ? `:${row.scheme}` : ""}, auth:${row.auth_kind}]`)}`;
			lines.push(head);
			lines.push(`  ${row.description}`);
			for (const ex of row.examples) {
				lines.push(`  ${colors.dim("example:")} ${ex}`);
			}
			if (row.notes) lines.push(`  ${colors.dim("note:")} ${row.notes}`);
			lines.push("");
		}
		lines.push(colors.dim(`${result.total} registered source${result.total === 1 ? "" : "s"}`));
		return lines.join("\n").trimEnd();
	},
	handler: async () => {
		const all = listSources();
		const sources = all.map((p) => ({
			name: p.name,
			description: p.description,
			notes: p.notes ?? null,
			match_kind: p.match.kind,
			scheme: p.match.kind === "scheme" ? p.match.prefix : null,
			auth_kind: ((p.logins?.[0]?.kind as "api_key" | undefined) ?? "none") as "api_key" | "none",
			requires_api_key: (p.logins?.[0]?.kind ?? "") === "api_key",
			platform: p.platform ?? null,
			examples: p.examples,
		}));
		return { sources, total: sources.length };
	},
});
