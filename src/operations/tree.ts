import { z } from "zod";
import { listAllCurrentPaths } from "../db/files.ts";
import { colors } from "../output/formatter.ts";
import { defineOperation } from "./types.ts";

interface TreeNode {
	name: string;
	full_path: string;
	is_file: boolean;
	children?: TreeNode[];
	children_truncated?: number;
}

interface BuildNode {
	name: string;
	full_path: string;
	is_file: boolean;
	childMap: Map<string, BuildNode>;
}

export const treeOperation = defineOperation({
	name: "membot_tree",
	cliName: "tree",
	bashEquivalent: "tree",
	description: `Render the logical-path tree of the current store. Tree is synthesised from "/" segments in logical_path — there are no real directories. Tombstoned and historical versions are hidden. Use this before membot_add to pick a sensible logical path.`,
	inputSchema: z.object({
		prefix: z.string().optional().describe("Only show paths starting with this prefix"),
		max_depth: z.number().default(4).describe("How many path segments deep to render"),
		max_items: z
			.number()
			.default(20)
			.describe("Max children to render at each level; remainder is summarised as '+N more'"),
	}),
	outputSchema: z.object({
		root: z.string(),
		tree: z.array(
			z.object({
				name: z.string(),
				full_path: z.string(),
				is_file: z.boolean(),
				children: z.array(z.unknown()).optional(),
				children_truncated: z.number().optional(),
			}),
		),
		truncated: z.number().optional(),
	}),
	cli: { positional: ["prefix"] },
	console_formatter: (result) => {
		const lines: string[] = [colors.bold(result.root)];
		const nodes = result.tree as TreeNode[];
		const topTruncated = (result as { truncated?: number }).truncated ?? 0;
		renderNodes(nodes, "", lines, topTruncated);
		if (lines.length === 1) lines.push(colors.dim("(empty)"));
		return lines.join("\n");
	},
	handler: async (input, ctx) => {
		const allPaths = await listAllCurrentPaths(ctx.db);
		const filtered = input.prefix ? allPaths.filter((p) => p.startsWith(input.prefix!)) : allPaths;
		const tree = buildTree(filtered, input.max_depth);
		const truncated = truncateTree(tree, input.max_items);
		return {
			root: input.prefix ?? "/",
			tree,
			...(truncated > 0 ? { truncated } : {}),
		};
	},
});

/**
 * Build a tree of TreeNode objects from a flat list of `/`-delimited paths.
 * Splits each path into segments and groups by common prefix; segments deeper
 * than `maxDepth` are dropped (the ancestor at depth `maxDepth - 1` keeps no
 * trace of them). Children are sorted by name within each level.
 */
export function buildTree(paths: string[], maxDepth: number): TreeNode[] {
	const roots = new Map<string, BuildNode>();
	for (const path of paths) {
		const segs = path.split("/").filter(Boolean);
		if (segs.length === 0) continue;
		let level = roots;
		const trail: string[] = [];
		for (let i = 0; i < segs.length && i < maxDepth; i++) {
			const seg = segs[i]!;
			trail.push(seg);
			const isLastSeg = i === segs.length - 1;
			let node = level.get(seg);
			if (!node) {
				node = { name: seg, full_path: trail.join("/"), is_file: isLastSeg, childMap: new Map() };
				level.set(seg, node);
			} else if (isLastSeg) {
				node.is_file = true;
			}
			level = node.childMap;
		}
	}
	return finalize([...roots.values()]);
}

/**
 * Convert the internal BuildNode graph into the public TreeNode shape, sorting
 * each level by name so downstream rendering and truncation are deterministic.
 */
function finalize(nodes: BuildNode[]): TreeNode[] {
	return nodes
		.map((n) => {
			const out: TreeNode = { name: n.name, full_path: n.full_path, is_file: n.is_file };
			if (n.childMap.size > 0) out.children = finalize([...n.childMap.values()]);
			return out;
		})
		.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Trim each child list (and the root list) to `maxItems`, mutating in place.
 * Returns the number of root entries dropped; per-node drops are recorded on
 * `node.children_truncated`. Input is assumed pre-sorted (by `finalize`) so
 * "first N" is stable.
 */
export function truncateTree(nodes: TreeNode[], maxItems: number): number {
	for (const node of nodes) {
		if (node.children?.length) {
			const dropped = truncateTree(node.children, maxItems);
			if (dropped > 0) node.children_truncated = dropped;
		}
	}
	if (nodes.length > maxItems) {
		const dropped = nodes.length - maxItems;
		nodes.length = maxItems;
		return dropped;
	}
	return 0;
}

/**
 * Walk a tree and append `├── name` / `└── name` lines with proper continuation
 * prefixes. Directories are rendered in cyan-bold; files in plain text. When a
 * level was truncated, a dim trailing `+N more` line is appended at that level.
 */
function renderNodes(nodes: TreeNode[], prefix: string, out: string[], truncatedCount = 0): void {
	nodes.forEach((node, i) => {
		const last = i === nodes.length - 1 && truncatedCount === 0;
		const branch = last ? "└── " : "├── ";
		const label = node.is_file && !node.children?.length ? node.name : colors.cyan(colors.bold(node.name));
		out.push(`${prefix}${branch}${label}`);
		if (node.children?.length) {
			renderNodes(node.children, prefix + (last ? "    " : "│   "), out, node.children_truncated ?? 0);
		}
	});
	if (truncatedCount > 0) {
		out.push(`${prefix}└── ${colors.dim(`+${truncatedCount} more`)}`);
	}
}
