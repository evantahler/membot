import { z } from "zod";
import { listDueRefreshes } from "../db/files.ts";
import { colors } from "../output/formatter.ts";
import { refreshOne } from "../refresh/runner.ts";
import { defineOperation } from "./types.ts";

export const refreshOperation = defineOperation({
	name: "membot_refresh",
	cliName: "refresh",
	description: `Re-read a file's source and create a new version only if the source bytes changed. Pass \`logical_path\` to refresh one file, or omit it to refresh every file whose refresh_frequency_sec has elapsed. Local files are detected via mtime+sha; remote files are re-fetched via the same downloader (Google Docs, GitHub, etc.) that was originally chosen. On auth or network failure the prior version stays current — check \`last_refresh_status\`. If the failure mentions a login redirect, re-run \`membot login\` and try again.`,
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
	console_formatter: (result) => {
		if (result.processed.length === 0) return colors.dim("(nothing due to refresh)");
		let updated = 0;
		let unchanged = 0;
		let failed = 0;
		const lines = result.processed.map((p) => {
			if (p.status === "ok") {
				updated++;
				const ver = p.new_version_id ? colors.dim(`→ ${p.new_version_id}`) : "";
				return `${colors.green("✓")} ${colors.cyan(p.logical_path)} ${ver}`;
			}
			if (p.status === "unchanged") {
				unchanged++;
				return `${colors.dim("·")} ${colors.dim(p.logical_path)} ${colors.dim("(unchanged)")}`;
			}
			failed++;
			return `${colors.red("✗")} ${p.logical_path} ${colors.dim(p.error ?? "")}`;
		});
		const parts = [colors.green(`updated ${updated}`), colors.dim(`unchanged ${unchanged}`)];
		if (failed) parts.push(colors.red(`failed ${failed}`));
		return `${lines.join("\n")}\n${parts.join(", ")}`;
	},
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
				const r = await refreshOne(ctx, path, input.force, (sublabel) => ctx.progress.update(sublabel));
				out.push(r);
			} catch (err) {
				out.push({ logical_path: path, status: "failed", error: err instanceof Error ? err.message : String(err) });
			}
		}
		ctx.progress.done(`refresh: ${out.filter((r) => r.status === "ok").length}/${out.length} updated`);
		return { processed: out, count: out.length };
	},
});
