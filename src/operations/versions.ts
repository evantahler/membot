import { z } from "zod";
import { listVersions } from "../db/files.ts";
import { defineOperation } from "./types.ts";

export const versionsOperation = defineOperation({
	name: "membot_versions",
	cliName: "versions",
	description: `List every version of a file (newest first) with version_id, content_sha256, size, change_note, and refresh status. Use this to find the version_id you want to pass to membot_read or membot_diff. Tombstoned versions are included and flagged.`,
	inputSchema: z.object({
		logical_path: z.string().describe("Path whose versions to list"),
	}),
	outputSchema: z.object({
		logical_path: z.string(),
		versions: z.array(
			z.object({
				version_id: z.string(),
				content_sha256: z.string().nullable(),
				source_sha256: z.string().nullable(),
				size_bytes: z.number().nullable(),
				change_note: z.string().nullable(),
				last_refresh_status: z.string().nullable(),
				tombstone: z.boolean(),
				created_at: z.string(),
			}),
		),
	}),
	cli: { positional: ["logical_path"] },
	handler: async (input, ctx) => {
		const versions = await listVersions(ctx.db, input.logical_path);
		return {
			logical_path: input.logical_path,
			versions: versions.map((v) => ({
				version_id: v.version_id,
				content_sha256: v.content_sha256,
				source_sha256: v.source_sha256,
				size_bytes: v.size_bytes,
				change_note: v.change_note,
				last_refresh_status: v.last_refresh_status,
				tombstone: v.tombstone,
				created_at: v.created_at,
			})),
		};
	},
});
