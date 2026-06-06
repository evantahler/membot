import { z } from "zod";
import { getCurrent, getVersion } from "../db/files.ts";
import { HelpfulError } from "../errors.ts";
import { normalizeLogicalPath } from "../ingest/ingest.ts";
import { colors } from "../output/formatter.ts";
import { defineOperation } from "./types.ts";

export const diffOperation = defineOperation({
	name: "membot_diff",
	cliName: "diff",
	bashEquivalent: "diff",
	description: `Return a unified diff between two versions of a file. \`a\` is required; \`b\` defaults to the current version. Both \`a\` and \`b\` are version_id timestamps from membot_versions. Use to understand what a refresh actually changed before deciding to act on the new content.`,
	inputSchema: z.object({
		logical_path: z.string().describe("Path of the file"),
		a: z.string().describe("Older version_id"),
		b: z.string().optional().describe("Newer version_id; default current"),
	}),
	outputSchema: z.object({
		logical_path: z.string(),
		a: z.string(),
		b: z.string(),
		diff: z.string(),
	}),
	cli: { positional: ["logical_path", "a", "b"] },
	console_formatter: (result) => {
		const header = `${colors.bold(result.logical_path)} ${colors.dim(`${result.a} → ${result.b}`)}`;
		if (!result.diff.trim()) return `${header}\n${colors.dim("(no changes)")}`;
		const body = result.diff
			.split("\n")
			.map((line) => {
				if (line.startsWith("---") || line.startsWith("+++") || line.startsWith("@@")) return colors.cyan(line);
				if (line.startsWith("+")) return colors.green(line);
				if (line.startsWith("-")) return colors.red(line);
				return line;
			})
			.join("\n");
		return `${header}\n${body}`;
	},
	handler: async (input, ctx) => {
		const path = normalizeLogicalPath(input.logical_path);
		const aRow = await getVersion(ctx.db, path, input.a);
		const bRow = input.b ? await getVersion(ctx.db, path, input.b) : await getCurrent(ctx.db, path);
		if (!aRow || !bRow) {
			throw new HelpfulError({
				kind: "not_found",
				message: `couldn't load both versions for diff (${aRow ? "" : "a missing"} ${bRow ? "" : "b missing"})`.trim(),
				hint: `Run \`membot versions ${path}\` to list valid version_ids.`,
			});
		}
		const diff = unifiedDiff(aRow.content ?? "", bRow.content ?? "", input.a, bRow.version_id);
		return { logical_path: path, a: aRow.version_id, b: bRow.version_id, diff };
	},
});

/**
 * Produce a minimal unified diff between two strings using a simple LCS
 * algorithm. We don't pull in a diff library because the volumes are small
 * and the output format is a stable convenience for humans/agents reading
 * what changed across versions.
 */
function unifiedDiff(a: string, b: string, aLabel: string, bLabel: string): string {
	const aLines = a.split("\n");
	const bLines = b.split("\n");
	const out: string[] = [`--- ${aLabel}`, `+++ ${bLabel}`];

	// Simple line-by-line walk using LCS.
	const lcs = lcsTable(aLines, bLines);
	let i = 0;
	let j = 0;
	const ops: { kind: "=" | "-" | "+"; line: string }[] = [];
	while (i < aLines.length && j < bLines.length) {
		if (aLines[i] === bLines[j]) {
			ops.push({ kind: "=", line: aLines[i]! });
			i++;
			j++;
		} else if ((lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0)) {
			ops.push({ kind: "-", line: aLines[i]! });
			i++;
		} else {
			ops.push({ kind: "+", line: bLines[j]! });
			j++;
		}
	}
	while (i < aLines.length) ops.push({ kind: "-", line: aLines[i++]! });
	while (j < bLines.length) ops.push({ kind: "+", line: bLines[j++]! });

	for (const op of ops) {
		out.push(`${op.kind === "=" ? " " : op.kind}${op.line}`);
	}
	return out.join("\n");
}

/** Build the LCS dynamic-programming table for two arrays. */
function lcsTable(a: string[], b: string[]): number[][] {
	const m = a.length;
	const n = b.length;
	const t: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
	for (let i = m - 1; i >= 0; i--) {
		const ti = t[i]!;
		const tin = t[i + 1]!;
		for (let j = n - 1; j >= 0; j--) {
			ti[j] = a[i] === b[j] ? (tin[j + 1] ?? 0) + 1 : Math.max(tin[j] ?? 0, ti[j + 1] ?? 0);
		}
	}
	return t;
}
