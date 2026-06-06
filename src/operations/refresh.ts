import { z } from "zod";
import { resolveEmbeddingWorkers } from "../context.ts";
import { listDueRefreshes } from "../db/files.ts";
import { withEmbedderPool } from "../ingest/embedder-pool.ts";
import { normalizeLogicalPath } from "../ingest/ingest.ts";
import { colors } from "../output/formatter.ts";
import { isInteractive } from "../output/tty.ts";
import { refreshOne } from "../refresh/runner.ts";
import { defineOperation } from "./types.ts";

interface RefreshEntry {
	logical_path: string;
	status: "ok" | "unchanged" | "failed";
	new_version_id?: string;
	error?: string;
}

/** Render one refresh result as a persistent stderr / final-summary line. */
function formatEntryLine(p: RefreshEntry): string {
	if (p.status === "ok") {
		const ver = p.new_version_id ? colors.dim(`→ ${p.new_version_id}`) : "";
		return `${colors.green("✓")} ${colors.cyan(p.logical_path)} ${ver}`;
	}
	if (p.status === "unchanged") {
		return `${colors.dim("·")} ${colors.dim(p.logical_path)} ${colors.dim("(unchanged)")}`;
	}
	return `${colors.red("✗")} ${p.logical_path} ${colors.dim(p.error ?? "")}`;
}

export const refreshOperation = defineOperation({
	name: "membot_refresh",
	cliName: "refresh",
	description: `Re-read a file's source and create a new version only if the source bytes changed. Pass \`logical_path\` to refresh one file, or omit it to refresh every file whose refresh_frequency_sec has elapsed. Local files are detected via mtime+sha; remote files are re-fetched via the same downloader (GitHub, Linear, etc.) that was originally chosen. On auth or network failure the prior version stays current — check \`last_refresh_status\`. If it failed on auth, set the service's key with \`membot config set downloaders.<svc>.api_key\` (see \`membot_sources\`) and retry.`,
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
		for (const p of result.processed) {
			if (p.status === "ok") updated++;
			else if (p.status === "unchanged") unchanged++;
			else failed++;
		}
		const parts = [colors.green(`updated ${updated}`), colors.dim(`unchanged ${unchanged}`)];
		if (failed) parts.push(colors.red(`failed ${failed}`));
		const summary = parts.join(", ");

		// In interactive mode the per-entry results were already streamed to
		// stderr via progress.entry() during the run; printing the same list
		// to stdout would just duplicate the scrollback. Non-interactive
		// callers (JSON, piped, CI) still get the full list.
		if (isInteractive()) return summary;

		const lines = result.processed.map(formatEntryLine);
		return `${lines.join("\n")}\n${summary}`;
	},
	handler: async (input, ctx) => {
		// Resolve the target list before opening the pool so we can clamp
		// worker count by entry count: a one-path refresh (the common case)
		// hits the inline short-circuit in withEmbedderPool and skips the
		// subprocess spawn entirely.
		const targets = input.logical_path
			? [normalizeLogicalPath(input.logical_path)]
			: (await listDueRefreshes(ctx.db)).map((r) => r.logical_path);

		// Per-command embedder pool: workers come up at the start of the
		// refresh sweep and are killed before we return, so a manual
		// `membot refresh` doesn't leave subprocesses around.
		const configuredWorkers = resolveEmbeddingWorkers(ctx.config.embedding.workers);
		const workers = Math.max(1, Math.min(configuredWorkers, targets.length));
		return withEmbedderPool(workers, ctx.config.embedding_model, async () => {
			const out: RefreshEntry[] = [];
			ctx.progress.start(targets.length, "refresh");
			for (const path of targets) {
				ctx.progress.setLabel(path);
				let entry: RefreshEntry;
				try {
					entry = await refreshOne(ctx, path, input.force, (sublabel) => ctx.progress.update(sublabel));
				} catch (err) {
					entry = { logical_path: path, status: "failed", error: err instanceof Error ? err.message : String(err) };
				}
				out.push(entry);
				ctx.progress.tick(path);
				ctx.progress.entry(formatEntryLine(entry));
			}
			ctx.progress.done(`refresh: ${out.filter((r) => r.status === "ok").length}/${out.length} updated`);
			return { processed: out, count: out.length };
		});
	},
});
