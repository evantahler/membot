import { z } from "zod";
import { listDueRefreshes } from "../db/files.ts";
import { refreshOne } from "../refresh/runner.ts";
import { defineOperation } from "./types.ts";

export const refreshOperation = defineOperation({
	name: "membot_refresh",
	cliName: "refresh",
	description: `Re-read a file's source and create a new version only if the source bytes changed. Pass \`logical_path\` to refresh one file, or omit it to refresh every file whose refresh_frequency_sec has elapsed. Local files are detected via mtime+sha; remote files are re-fetched via the same mcpx invocation that was originally used. On auth or network failure the prior version stays current — check \`last_refresh_status\`.`,
	inputSchema: z.object({
		logical_path: z.string().optional().describe("Single path to refresh; omit for all-due"),
		force: z.boolean().default(false).describe("Re-embed even if source sha is unchanged"),
	}),
	outputSchema: z.object({
		processed: z.array(
			z.object({
				logical_path: z.string(),
				status: z.enum(["ok", "unchanged", "failed"]),
				new_version_id: z.string().optional(),
				error: z.string().optional(),
			}),
		),
		count: z.number(),
	}),
	cli: { positional: ["logical_path"] },
	handler: async (input, ctx) => {
		const targets = input.logical_path
			? [input.logical_path]
			: (await listDueRefreshes(ctx.db)).map((r) => r.logical_path);
		const out: Array<{
			logical_path: string;
			status: "ok" | "unchanged" | "failed";
			new_version_id?: string;
			error?: string;
		}> = [];
		ctx.progress.start(targets.length, "refresh");
		for (const path of targets) {
			ctx.progress.tick(path);
			try {
				const r = await refreshOne(ctx, path, input.force);
				out.push(r);
			} catch (err) {
				out.push({ logical_path: path, status: "failed", error: err instanceof Error ? err.message : String(err) });
			}
		}
		ctx.progress.done(`refresh: ${out.filter((r) => r.status === "ok").length}/${out.length} updated`);
		return { processed: out, count: out.length };
	},
});
