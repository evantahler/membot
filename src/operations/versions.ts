import { z } from "zod";
import { listVersions } from "../db/files.ts";
import { normalizeLogicalPath } from "../ingest/ingest.ts";
import { colors, renderTable } from "../output/formatter.ts";
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
	console_formatter: (result) => {
		if (result.versions.length === 0) {
			return `${colors.cyan(result.logical_path)}\n${colors.dim("(no versions)")}`;
		}
		// Newest first — first row is current unless tombstoned.
		let currentMarked = false;
		const rows = result.versions.map((v) => {
			let marker = " ";
			if (!currentMarked && !v.tombstone) {
				marker = colors.green("→");
				currentMarked = true;
			}
			const status = v.tombstone
				? colors.red("tombstone")
				: v.last_refresh_status === "failed"
					? colors.red(v.last_refresh_status)
					: (v.last_refresh_status ?? "-");
			return [
				marker,
				v.tombstone ? colors.dim(v.version_id) : v.version_id,
				v.created_at,
				v.size_bytes !== null ? String(v.size_bytes) : "-",
				(v.content_sha256 ?? "-").slice(0, 12),
				status,
				v.change_note ?? "",
			];
		});
		const header = `${colors.bold(result.logical_path)}`;
		const table = renderTable(["", "VERSION", "CREATED", "SIZE", "SHA", "STATUS", "NOTE"], rows, {
			columnStyles: [undefined, colors.cyan, colors.dim, colors.dim, colors.dim],
		});
		return `${header}\n${table}`;
	},
	handler: async (input, ctx) => {
		const path = normalizeLogicalPath(input.logical_path);
		const versions = await listVersions(ctx.db, path);
		return {
			logical_path: path,
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
