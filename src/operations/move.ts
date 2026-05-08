import { z } from "zod";
import { insertChunksForVersion, listChunksForVersion, rebuildFts } from "../db/chunks.ts";
import { getCurrent, insertVersion, millisIso, tombstone } from "../db/files.ts";
import { HelpfulError } from "../errors.ts";
import { buildSearchText } from "../ingest/search-text.ts";
import { defineOperation } from "./types.ts";

export const moveOperation = defineOperation({
	name: "membot_move",
	cliName: "mv",
	bashEquivalent: "mv",
	description: `Rename a logical_path. Creates one new version under the new path with full content carried over and tombstones the old path. History remains queryable under both names via membot_versions.`,
	inputSchema: z.object({
		from_logical_path: z.string().describe("Source path"),
		to_logical_path: z.string().describe("Destination path"),
	}),
	outputSchema: z.object({
		from_logical_path: z.string(),
		to_logical_path: z.string(),
		new_version_id: z.string(),
	}),
	cli: { positional: ["from_logical_path", "to_logical_path"] },
	handler: async (input, ctx) => {
		const cur = await getCurrent(ctx.db, input.from_logical_path);
		if (!cur) {
			throw new HelpfulError({
				kind: "not_found",
				message: `${input.from_logical_path} doesn't exist (or is tombstoned)`,
				hint: "Run `membot ls` to see paths.",
			});
		}
		if (await getCurrent(ctx.db, input.to_logical_path)) {
			throw new HelpfulError({
				kind: "conflict",
				message: `${input.to_logical_path} already has a current version`,
				hint: "Pick a different destination or `membot rm` the existing one first.",
			});
		}
		const newVersion = millisIso(Date.now());
		await insertVersion(ctx.db, {
			logical_path: input.to_logical_path,
			version_id: newVersion,
			source_type: cur.source_type,
			source_path: cur.source_path,
			source_mtime_ms: cur.source_mtime_ms,
			source_sha256: cur.source_sha256,
			blob_sha256: cur.blob_sha256,
			content_sha256: cur.content_sha256,
			content: cur.content,
			description: cur.description,
			mime_type: cur.mime_type,
			size_bytes: cur.size_bytes,
			fetcher: cur.fetcher,
			fetcher_server: cur.fetcher_server,
			fetcher_tool: cur.fetcher_tool,
			fetcher_args: cur.fetcher_args,
			refresh_frequency_sec: cur.refresh_frequency_sec,
			refreshed_at: cur.refreshed_at,
			last_refresh_status: cur.last_refresh_status,
			change_note: `move from ${input.from_logical_path}`,
		});

		const oldChunks = await listChunksForVersion(ctx.db, cur.logical_path, cur.version_id);
		const reKeyed = oldChunks.map((c) => ({
			chunk_index: c.chunk_index,
			chunk_content: c.chunk_content,
			search_text: buildSearchText(input.to_logical_path, cur.description, c.chunk_content),
			embedding: c.embedding,
		}));
		await insertChunksForVersion(ctx.db, input.to_logical_path, newVersion, reKeyed);
		await tombstone(ctx.db, input.from_logical_path, `moved to ${input.to_logical_path}`);
		await rebuildFts(ctx.db);

		return {
			from_logical_path: input.from_logical_path,
			to_logical_path: input.to_logical_path,
			new_version_id: newVersion,
		};
	},
});
