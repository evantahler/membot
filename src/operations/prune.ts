import { z } from "zod";
import { gcOrphanBlobs, listBlobsWithBytes, stripBlobBytes } from "../db/blobs.ts";
import { pruneOldVersions } from "../db/files.ts";
import { HelpfulError } from "../errors.ts";
import { shouldPersistBlobBytes } from "../ingest/blob-policy.ts";
import { colors, formatBytes } from "../output/formatter.ts";
import { defineOperation } from "./types.ts";

export const pruneOperation = defineOperation({
	name: "membot_prune",
	cliName: "prune",
	description: `Permanently drop non-current versions older than the cutoff and garbage-collect orphan blobs. Pass --strip-blob-bytes to retroactively NULL out blob bytes for rows that would be skipped under the current blobs.max_size_bytes / blobs.skip_mime_types policy — the blobs row metadata stays, only the original bytes are dropped. Either --before or --strip-blob-bytes (or both) must be supplied. Current versions and tombstones-with-no-newer-version are preserved. Use sparingly — pruned versions cannot be recovered.`,
	inputSchema: z.object({
		before: z
			.string()
			.optional()
			.describe(
				"Duration (e.g. 30d, 7d) or absolute ISO timestamp — versions strictly older are dropped. Omit to skip version pruning (combine with --strip-blob-bytes).",
			),
		strip_blob_bytes: z
			.boolean()
			.default(false)
			.describe(
				"Retroactively NULL out blob bytes for rows that exceed the current blobs.max_size_bytes / blobs.skip_mime_types policy. Independent of --before; can be combined.",
			),
		dry_run: z.boolean().default(true).describe("Report what would be removed without changing the DB"),
	}),
	outputSchema: z.object({
		cutoff: z.string().nullable(),
		removed_versions: z.number(),
		removed_orphan_blobs: z.number(),
		stripped_blob_bytes: z.number(),
		reclaimed_bytes: z.number(),
		dry_run: z.boolean(),
	}),
	cli: { positional: ["before"] },
	console_formatter: (result) => {
		const tag = result.dry_run ? colors.yellow("[dry-run]") : colors.green("[applied]");
		const lines: string[] = [];
		const header = result.cutoff ? `${tag} cutoff ${colors.cyan(result.cutoff)}` : `${tag} no version cutoff`;
		lines.push(header);
		if (result.cutoff) {
			const verb = result.dry_run ? "would be dropped" : "dropped";
			lines.push(
				`${colors.yellow(`${result.removed_versions} version${result.removed_versions === 1 ? "" : "s"}`)} ${verb}`,
			);
			lines.push(
				result.dry_run
					? colors.dim("(orphan blob count not computed in dry-run)")
					: `${colors.yellow(`${result.removed_orphan_blobs} orphan blob${result.removed_orphan_blobs === 1 ? "" : "s"}`)} reclaimed`,
			);
		}
		if (result.stripped_blob_bytes > 0 || result.reclaimed_bytes > 0 || result.dry_run) {
			const verb = result.dry_run ? "would have bytes stripped" : "had bytes stripped";
			lines.push(
				`${colors.yellow(`${result.stripped_blob_bytes} blob${result.stripped_blob_bytes === 1 ? "" : "s"}`)} ${verb} (${formatBytes(result.reclaimed_bytes)} reclaimed)`,
			);
		}
		return lines.join("\n");
	},
	handler: async (input, ctx) => {
		if (!input.before && !input.strip_blob_bytes) {
			throw new HelpfulError({
				kind: "input_error",
				message: "prune called without --before or --strip-blob-bytes",
				hint: "Pass --before <duration|timestamp> to drop old versions, --strip-blob-bytes to null oversized blob bytes, or both.",
			});
		}

		const cutoff = input.before ? resolveCutoff(input.before) : null;
		let removed_versions = 0;
		let removed_orphan_blobs = 0;
		let stripped_blob_bytes = 0;
		let reclaimed_bytes = 0;

		if (cutoff) {
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
				removed_versions = Number(cnt);
			} else {
				const removed = await pruneOldVersions(ctx.db, cutoff);
				removed_versions = removed.removed;
				const orphans = await gcOrphanBlobs(ctx.db);
				removed_orphan_blobs = orphans.removed;
			}
		}

		if (input.strip_blob_bytes) {
			const candidates = await listBlobsWithBytes(ctx.db);
			const toStrip = candidates.filter(
				(b) => !shouldPersistBlobBytes(b.mime_type, b.size_bytes, ctx.config.blobs).persist,
			);
			if (input.dry_run) {
				stripped_blob_bytes = toStrip.length;
				// size_bytes is what we know without running the full octet_length scan;
				// dry-run accepts that approximation rather than touching every BLOB.
				reclaimed_bytes = toStrip.reduce((sum, b) => sum + b.size_bytes, 0);
			} else {
				const result = await stripBlobBytes(
					ctx.db,
					toStrip.map((b) => b.sha256),
				);
				stripped_blob_bytes = result.stripped;
				reclaimed_bytes = result.reclaimed_bytes;
			}
		}

		return {
			cutoff,
			removed_versions,
			removed_orphan_blobs,
			stripped_blob_bytes,
			reclaimed_bytes,
			dry_run: input.dry_run,
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
