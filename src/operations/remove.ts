import picomatch from "picomatch";
import { z } from "zod";
import { listAllCurrentPaths, tombstone } from "../db/files.ts";
import { asHelpful, HelpfulError } from "../errors.ts";
import { normalizeLogicalPath } from "../ingest/ingest.ts";
import { isGlob } from "../ingest/source-resolver.ts";
import { colors } from "../output/formatter.ts";
import { defineOperation } from "./types.ts";

export const removeOperation = defineOperation({
	name: "membot_remove",
	cliName: "rm",
	bashEquivalent: "rm",
	description: `Tombstone one or more logical_paths so they no longer appear in membot_list / membot_tree / membot_search. Each \`paths\` arg is independently treated as either a literal logical_path or a glob pattern (e.g. "docs/**/*.md"); globs are matched against current logical_paths in the DB, not the filesystem. To remove a whole directory subtree, pass a glob: \`dir/**\` (every path beneath \`dir/\`) or \`dir/*.md\` (one level, .md only) — a single \`*\` does not cross \`/\`. A bare \`*\` (or \`**\`) means "everything" — it tombstones the entire index and therefore requires \`force\` (\`-f\` / \`--force\`); without it the call is refused and reports how many files would be removed. When running on a shell you MUST quote the pattern (\`membot rm '*'\`, \`membot rm 'docs/**'\`) so the shell doesn't expand it against your working directory first. The union of matches is deduplicated, then tombstoned one at a time — partial failures are reported per-entry without aborting the rest. An input arg that matches zero current files is an error (the response includes which arg). Old versions remain queryable via membot_versions and membot_read with an explicit version. Use membot_prune to permanently drop history.`,
	inputSchema: z.object({
		paths: z
			.array(z.string())
			.min(1)
			.describe(
				'One or more logical_paths or glob patterns (e.g. "docs/**/*.md"). Each arg is matched independently against current logical_paths in the DB. Use `dir/**` to remove an entire subtree.',
			),
		force: z
			.boolean()
			.default(false)
			.describe(
				"Required to tombstone the entire index in one call (a bare `*` / `**` match-all). Without it, such a call is refused and reports how many files would be removed. Ignored for targeted removals. Mirrors `rm -f`.",
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
	cli: { positional: ["paths"], aliases: { change_note: "-m", force: "-f" } },
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
		// Whether any arg requested a whole-index clear (bare `*` / `**`). Such a
		// match-all must be confirmed with `force`; a targeted glob that happens to
		// hit every file in a small index does not trip this gate.
		let matchedAll = false;

		for (const rawArg of input.paths) {
			const arg = normalizeLogicalPath(rawArg);
			const matches: string[] = [];
			// A bare `*` / `**` means "everything": picomatch's `*` won't cross `/`,
			// so handle the match-all intent explicitly instead of through globbing.
			if (arg === "*" || arg === "**") {
				matchedAll = true;
				matches.push(...currentPaths);
			} else if (isGlob(arg)) {
				const isMatch = picomatch(arg, { dot: true });
				for (const p of currentPaths) {
					if (isMatch(p)) matches.push(p);
				}
			} else if (currentSet.has(arg)) {
				matches.push(arg);
			}
			if (matches.length === 0) {
				// A literal that is actually a directory prefix gets a glob-oriented
				// hint, since recursive removal is expressed as `dir/**` now.
				const normalized = arg.endsWith("/") ? arg.slice(0, -1) : arg;
				const isDirPrefix = currentPaths.some((p) => p.startsWith(`${normalized}/`));
				throw new HelpfulError({
					kind: "not_found",
					message: `no current files match \`${arg}\``,
					hint: isDirPrefix
						? `\`${normalized}\` is a directory — use \`${normalized}/**\` to tombstone everything under it.`
						: "Run `membot ls` to see active paths, or pass a glob like `dir/**`.",
				});
			}
			for (const m of matches) targets.add(m);
		}

		if (matchedAll && !input.force) {
			throw new HelpfulError({
				kind: "input_error",
				message: `refusing to tombstone all ${targets.size} files without confirmation`,
				hint: "Re-run with `-f` / `--force` to clear the entire index. Old versions stay recoverable via `membot versions`.",
			});
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
