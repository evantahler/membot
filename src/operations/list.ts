import { z } from "zod";
import { listCurrent } from "../db/files.ts";
import { defineOperation } from "./types.ts";

export const listOperation = defineOperation({
	name: "membot_list",
	cliName: "ls",
	bashEquivalent: "ls",
	description: `List current files under an optional prefix, with size, mime type, refresh frequency, and last refresh status. Returns one row per logical_path (current version only). Pair with membot_tree for shape, membot_search for content-based discovery.`,
	inputSchema: z.object({
		prefix: z.string().optional().describe("Only show paths starting with this prefix"),
		limit: z.number().default(1000).describe("Max rows to return"),
		offset: z.number().default(0).describe("Skip this many rows (paginate)"),
	}),
	outputSchema: z.object({
		entries: z.array(
			z.object({
				logical_path: z.string(),
				version_id: z.string(),
				size_bytes: z.number().nullable(),
				mime_type: z.string().nullable(),
				refresh_frequency_sec: z.number().nullable(),
				last_refresh_status: z.string().nullable(),
				refreshed_at: z.string().nullable(),
				description: z.string().nullable(),
			}),
		),
		count: z.number(),
	}),
	cli: { positional: ["prefix"] },
	handler: async (input, ctx) => {
		const rows = await listCurrent(ctx.db, {
			prefix: input.prefix,
			limit: input.limit,
			offset: input.offset,
		});
		return {
			entries: rows.map((r) => ({
				logical_path: r.logical_path,
				version_id: r.version_id,
				size_bytes: r.size_bytes,
				mime_type: r.mime_type,
				refresh_frequency_sec: r.refresh_frequency_sec,
				last_refresh_status: r.last_refresh_status,
				refreshed_at: r.refreshed_at,
				description: r.description,
			})),
			count: rows.length,
		};
	},
});
