import { addOperation } from "./add.ts";
import { diffOperation } from "./diff.ts";
import { infoOperation } from "./info.ts";
import { listOperation } from "./list.ts";
import { moveOperation } from "./move.ts";
import { pruneOperation } from "./prune.ts";
import { readOperation } from "./read.ts";
import { refreshOperation } from "./refresh.ts";
import { removeOperation } from "./remove.ts";
import { searchOperation } from "./search.ts";
import { sourcesOperation } from "./sources.ts";
import { statsOperation } from "./stats.ts";
import { treeOperation } from "./tree.ts";
import type { Operation } from "./types.ts";
import { versionsOperation } from "./versions.ts";
import { writeOperation } from "./write.ts";

/**
 * Ordered registry of every Operation. The CLI and the MCP server both
 * iterate this list and call the appropriate mount adapter, so a new tool
 * is added by writing one file under `operations/` and appending it here.
 *
 * Order influences `--help` output and MCP `tools/list` ordering.
 */
// biome-ignore lint/suspicious/noExplicitAny: heterogenous Operation generics — registry stays open-ended on purpose
export const OPERATIONS: Operation<any, any>[] = [
	addOperation,
	listOperation,
	treeOperation,
	readOperation,
	searchOperation,
	infoOperation,
	statsOperation,
	versionsOperation,
	diffOperation,
	writeOperation,
	moveOperation,
	removeOperation,
	refreshOperation,
	pruneOperation,
	sourcesOperation,
];
