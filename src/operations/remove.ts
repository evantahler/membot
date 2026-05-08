import { z } from "zod";
import { getCurrent, tombstone } from "../db/files.ts";
import { HelpfulError } from "../errors.ts";
import { colors } from "../output/formatter.ts";
import { defineOperation } from "./types.ts";

export const removeOperation = defineOperation({
	name: "membot_delete",
	cliName: "rm",
	bashEquivalent: "rm",
	description: `Tombstone a logical_path so it no longer appears in membot_list / membot_tree / membot_search. Old versions remain queryable via membot_versions and membot_read with an explicit version. Use membot_prune to permanently drop history.`,
	inputSchema: z.object({
		logical_path: z.string().describe("Path to tombstone"),
		change_note: z.string().optional().describe("Why this is being deleted"),
	}),
	outputSchema: z.object({
		logical_path: z.string(),
		tombstone_version_id: z.string(),
	}),
	cli: { positional: ["logical_path"], aliases: { change_note: "-m" } },
	console_formatter: (result) =>
		`${colors.green("✓")} tombstoned ${colors.cyan(result.logical_path)} ${colors.dim(`@ ${result.tombstone_version_id}`)}`,
	handler: async (input, ctx) => {
		const cur = await getCurrent(ctx.db, input.logical_path);
		if (!cur) {
			throw new HelpfulError({
				kind: "not_found",
				message: `${input.logical_path} doesn't exist (or is already tombstoned)`,
				hint: `Run \`membot ls\` to see active paths, or \`membot versions ${input.logical_path}\` to see history.`,
			});
		}
		const v = await tombstone(ctx.db, input.logical_path, input.change_note ?? "deleted");
		return { logical_path: input.logical_path, tombstone_version_id: v };
	},
});
