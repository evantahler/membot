import { z } from "zod";
import { getCurrent, getVersion } from "../db/files.ts";
import { HelpfulError } from "../errors.ts";
import { colors } from "../output/formatter.ts";
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
		downloader: z.string().nullable(),
		downloader_args: z.record(z.string(), z.unknown()).nullable(),
		refresh_frequency_sec: z.number().nullable(),
		refreshed_at: z.string().nullable(),
		last_refresh_status: z.string().nullable(),
		change_note: z.string().nullable(),
		created_at: z.string(),
		tombstone: z.boolean(),
	}),
	cli: { positional: ["logical_path"] },
	console_formatter: (result) => {
		const fmt = (k: string, v: string): string => `${colors.dim(k.padEnd(22))}${v}`;
		const yn = (b: boolean): string => (b ? colors.green("yes") : colors.dim("no"));
		const orDash = (s: string | null): string => s ?? colors.dim("-");
		const lines: string[] = [];
		const head = `${colors.cyan(result.logical_path)} ${colors.dim(`@ ${result.version_id}`)}`;
		lines.push(result.tombstone ? `${head} ${colors.red("[tombstoned]")}` : head);
		lines.push(fmt("current", yn(result.version_is_current)));
		lines.push(fmt("source_type", orDash(result.source_type)));
		lines.push(fmt("source_path", orDash(result.source_path)));
		lines.push(fmt("mime_type", orDash(result.mime_type)));
		lines.push(fmt("size_bytes", result.size_bytes !== null ? String(result.size_bytes) : colors.dim("-")));
		lines.push(fmt("description", orDash(result.description)));
		lines.push(fmt("content_sha256", orDash(result.content_sha256)));
		lines.push(fmt("blob_sha256", orDash(result.blob_sha256)));
		lines.push(fmt("source_sha256", orDash(result.source_sha256)));
		if (result.fetcher) lines.push(fmt("fetcher", result.fetcher));
		if (result.downloader) lines.push(fmt("downloader", result.downloader));
		if (result.downloader_args) lines.push(fmt("downloader_args", JSON.stringify(result.downloader_args)));
		lines.push(
			fmt(
				"refresh_frequency",
				result.refresh_frequency_sec !== null ? `${result.refresh_frequency_sec}s` : colors.dim("-"),
			),
		);
		lines.push(fmt("refreshed_at", orDash(result.refreshed_at)));
		lines.push(
			fmt(
				"last_refresh_status",
				result.last_refresh_status === "failed"
					? colors.red(result.last_refresh_status)
					: result.last_refresh_status === "ok" || result.last_refresh_status === "fresh"
						? colors.green(result.last_refresh_status)
						: orDash(result.last_refresh_status),
			),
		);
		if (result.change_note) lines.push(fmt("change_note", result.change_note));
		lines.push(fmt("created_at", result.created_at));
		return lines.join("\n");
	},
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
