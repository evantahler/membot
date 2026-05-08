import { z } from "zod";
import { gcOrphanBlobs } from "../db/blobs.ts";
import { pruneOldVersions } from "../db/files.ts";
import { HelpfulError } from "../errors.ts";
import { colors } from "../output/formatter.ts";
import { defineOperation } from "./types.ts";

export const pruneOperation = defineOperation({
	name: "membot_prune",
	cliName: "prune",
	description: `Permanently drop non-current versions older than the cutoff and garbage-collect orphan blobs. Current versions and tombstones-with-no-newer-version are preserved. Use sparingly — pruned versions cannot be recovered.`,
	inputSchema: z.object({
		before: z
			.string()
			.describe("Duration (e.g. 30d, 7d) or absolute ISO timestamp — versions strictly older are dropped"),
		dry_run: z.boolean().default(true).describe("Report what would be removed without changing the DB"),
	}),
	outputSchema: z.object({
		cutoff: z.string(),
		removed_versions: z.number(),
		removed_orphan_blobs: z.number(),
		dry_run: z.boolean(),
	}),
	cli: { positional: ["before"] },
	console_formatter: (result) => {
		const tag = result.dry_run ? colors.yellow("[dry-run]") : colors.green("[applied]");
		const head = `${tag} cutoff ${colors.cyan(result.cutoff)}`;
		const versions = `${colors.yellow(`${result.removed_versions} version${result.removed_versions === 1 ? "" : "s"}`)} would be dropped`;
		const blobs = result.dry_run
			? colors.dim("(orphan blob count not computed in dry-run)")
			: `${colors.yellow(`${result.removed_orphan_blobs} orphan blob${result.removed_orphan_blobs === 1 ? "" : "s"}`)} reclaimed`;
		return `${head}\n${versions}\n${blobs}`;
	},
	handler: async (input, ctx) => {
		const cutoff = resolveCutoff(input.before);
		if (input.dry_run) {
			const cnt =
				(
					await ctx.db.queryGet<{ n: number }>(
						`SELECT COUNT(*) AS n FROM files
				 WHERE version_id < CAST(?1 AS TIMESTAMP)
				   AND (logical_path, version_id) NOT IN (
				     SELECT logical_path, MAX(version_id) FROM files GROUP BY logical_path
				   )`,
						cutoff,
					)
				)?.n ?? 0;
			return { cutoff, removed_versions: Number(cnt), removed_orphan_blobs: 0, dry_run: true };
		}
		const removed = await pruneOldVersions(ctx.db, cutoff);
		const orphans = await gcOrphanBlobs(ctx.db);
		return {
			cutoff,
			removed_versions: removed.removed,
			removed_orphan_blobs: orphans.removed,
			dry_run: false,
		};
	},
});

/** Convert a duration string or ISO timestamp into an ISO cutoff. */
function resolveCutoff(input: string): string {
	const trimmed = input.trim();
	const m = trimmed.match(/^(\d+)([smhd])$/i);
	if (m) {
		const n = Number(m[1]);
		const unit = m[2]?.toLowerCase() ?? "s";
		const sec = unit === "s" ? 1 : unit === "m" ? 60 : unit === "h" ? 3600 : 86400;
		return new Date(Date.now() - n * sec * 1000).toISOString();
	}
	const parsed = Date.parse(trimmed);
	if (Number.isNaN(parsed)) {
		throw new HelpfulError({
			kind: "input_error",
			message: `invalid --before: ${input}`,
			hint: "Use a duration like 30d, or an ISO-8601 timestamp like 2024-01-01T00:00:00Z.",
		});
	}
	return new Date(parsed).toISOString();
}
