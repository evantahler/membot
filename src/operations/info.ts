import { z } from "zod";
import { getCurrent, getVersion } from "../db/files.ts";
import { HelpfulError } from "../errors.ts";
import { defineOperation } from "./types.ts";

export const infoOperation = defineOperation({
	name: "membot_info",
	cliName: "info",
	description: `Inspect metadata for a file: source (local path or URL), fetcher used, refresh schedule, last refresh status, all sha256 digests, and whether the requested version is the current one. Does NOT return file content — use membot_read for that. Use this to decide whether a refresh is worth forcing or whether to trust a cached row.`,
	inputSchema: z.object({
		logical_path: z.string().describe("Path to inspect"),
		version: z.string().optional().describe("Specific version_id; default current"),
	}),
	outputSchema: z.object({
		logical_path: z.string(),
		version_id: z.string(),
		version_is_current: z.boolean(),
		source_type: z.string(),
		source_path: z.string().nullable(),
		source_sha256: z.string().nullable(),
		blob_sha256: z.string().nullable(),
		content_sha256: z.string().nullable(),
		mime_type: z.string().nullable(),
		size_bytes: z.number().nullable(),
		description: z.string().nullable(),
		fetcher: z.string().nullable(),
		fetcher_server: z.string().nullable(),
		fetcher_tool: z.string().nullable(),
		fetcher_args: z.record(z.string(), z.unknown()).nullable(),
		refresh_frequency_sec: z.number().nullable(),
		refreshed_at: z.string().nullable(),
		last_refresh_status: z.string().nullable(),
		change_note: z.string().nullable(),
		created_at: z.string(),
		tombstone: z.boolean(),
	}),
	cli: { positional: ["logical_path"] },
	handler: async (input, ctx) => {
		const cur = await getCurrent(ctx.db, input.logical_path);
		const row = input.version ? await getVersion(ctx.db, input.logical_path, input.version) : cur;
		if (!row) {
			throw new HelpfulError({
				kind: "not_found",
				message: `no version of ${input.logical_path}${input.version ? ` at ${input.version}` : ""}`,
				hint: `Run \`membot versions ${input.logical_path}\` to list versions, or \`membot ls\` for paths.`,
			});
		}
		return {
			...row,
			version_is_current: !!cur && cur.version_id === row.version_id,
		};
	},
});
