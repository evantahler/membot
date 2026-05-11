import picomatch from "picomatch";
import { z } from "zod";
import { listAllCurrentPaths, tombstone } from "../db/files.ts";
import { asHelpful, HelpfulError } from "../errors.ts";
import { normalizeLogicalPath } from "../ingest/ingest.ts";
import { isGlob } from "../ingest/source-resolver.ts";
import { colors } from "../output/formatter.ts";
import { defineOperation } from "./types.ts";

export const removeOperation = defineOperation({
	name: "membot_delete",
	cliName: "rm",
	bashEquivalent: "rm",
	description: `Tombstone one or more logical_paths so they no longer appear in membot_list / membot_tree / membot_search. Each \`paths\` arg is independently treated as either a literal logical_path or a glob pattern (e.g. "docs/**/*.md"); globs are matched against current logical_paths in the DB, not the filesystem. A literal arg that matches no exact file but is a prefix of existing paths (a "directory") is rejected unless \`recursive\` is true, in which case every path beneath it is tombstoned. The union of matches is deduplicated, then tombstoned one at a time — partial failures are reported per-entry without aborting the rest. An input arg that matches zero current files is an error (the response includes which arg). Old versions remain queryable via membot_versions and membot_read with an explicit version. Use membot_prune to permanently drop history.`,
	inputSchema: z.object({
		paths: z
			.array(z.string())
			.min(1)
			.describe(
				'One or more logical_paths or glob patterns (e.g. "docs/**/*.md"). Each arg is matched independently against current logical_paths in the DB.',
			),
		recursive: z
			.boolean()
			.default(false)
			.describe(
				"If a literal path arg matches no file but is a prefix of existing paths, treat it as a directory and remove everything beneath it. Mirrors `rm -r`. Ignored for glob args.",
			),
		change_note: z.string().optional().describe("Why this is being deleted"),
	}),
	outputSchema: z.object({
		removed: z.array(
			z.object({
				logical_path: z.string(),
				version_id: z.string().nullable(),
				status: z.enum(["ok", "failed"]),
				error: z.string().optional(),
			}),
		),
		total: z.number(),
		ok: z.number(),
		failed: z.number(),
	}),
	cli: { positional: ["paths"], aliases: { change_note: "-m", recursive: "-r" } },
	console_formatter: (result) => {
		const lines = result.removed.map((e) =>
			e.status === "ok"
				? `${colors.green("✓")} tombstoned ${colors.cyan(e.logical_path)} ${colors.dim(`@ ${e.version_id}`)}`
				: `${colors.red("✗")} ${e.logical_path} ${colors.dim(e.error ?? "")}`,
		);
		const summary = result.failed
			? `${colors.green(`removed ${result.ok}`)}, ${colors.red(`failed ${result.failed}`)}`
			: colors.green(`removed ${result.ok}`);
		return `${lines.join("\n")}\n${summary}`;
	},
	handler: async (input, ctx) => {
		const currentPaths = await listAllCurrentPaths(ctx.db);
		const currentSet = new Set(currentPaths);
		const targets = new Set<string>();

		for (const rawArg of input.paths) {
			const arg = normalizeLogicalPath(rawArg);
			const matches: string[] = [];
			if (isGlob(arg)) {
				const isMatch = picomatch(arg, { dot: true });
				for (const p of currentPaths) {
					if (isMatch(p)) matches.push(p);
				}
			} else if (currentSet.has(arg)) {
				matches.push(arg);
			} else {
				const normalized = arg.endsWith("/") ? arg.slice(0, -1) : arg;
				const dirPrefix = `${normalized}/`;
				const dirMatches = currentPaths.filter((p) => p.startsWith(dirPrefix));
				if (dirMatches.length > 0) {
					if (input.recursive) {
						matches.push(...dirMatches);
					} else {
						throw new HelpfulError({
							kind: "not_found",
							message: `\`${arg}\` is a directory (${dirMatches.length} files); pass --recursive to remove its contents`,
							hint: `Re-run with \`-r\` / \`--recursive\` to tombstone every path under \`${normalized}/\`.`,
						});
					}
				}
			}
			if (matches.length === 0) {
				throw new HelpfulError({
					kind: "not_found",
					message: `no current files match \`${arg}\``,
					hint: "Run `membot ls` to see active paths, or pass a different glob.",
				});
			}
			for (const m of matches) targets.add(m);
		}

		const note = input.change_note ?? "deleted";
		const removed: { logical_path: string; version_id: string | null; status: "ok" | "failed"; error?: string }[] = [];
		for (const path of targets) {
			try {
				const versionId = await tombstone(ctx.db, path, note);
				removed.push({ logical_path: path, version_id: versionId, status: "ok" });
			} catch (err) {
				const helpful = asHelpful(err, `while tombstoning ${path}`, "Re-run with --verbose to see the cause.");
				removed.push({
					logical_path: path,
					version_id: null,
					status: "failed",
					error: helpful.message,
				});
			}
		}

		const ok = removed.filter((r) => r.status === "ok").length;
		const failed = removed.length - ok;
		return { removed, total: removed.length, ok, failed };
	},
});
