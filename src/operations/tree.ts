import { z } from "zod";
import { listAllCurrentPaths } from "../db/files.ts";
import { defineOperation } from "./types.ts";

interface TreeNode {
	name: string;
	full_path: string;
	is_file: boolean;
	children?: TreeNode[];
}

export const treeOperation = defineOperation({
	name: "membot_tree",
	cliName: "tree",
	bashEquivalent: "tree",
	description: `Render the logical-path tree of the current store. Tree is synthesised from "/" segments in logical_path — there are no real directories. Tombstoned and historical versions are hidden. Use this before membot_add to pick a sensible logical path.`,
	inputSchema: z.object({
		prefix: z.string().optional().describe("Only show paths starting with this prefix"),
		max_depth: z.number().default(4).describe("How many path segments deep to render"),
	}),
	outputSchema: z.object({
		root: z.string(),
		tree: z.array(
			z.object({
				name: z.string(),
				full_path: z.string(),
				is_file: z.boolean(),
				children: z.array(z.unknown()).optional(),
			}),
		),
	}),
	cli: { positional: ["prefix"] },
	handler: async (input, ctx) => {
		const allPaths = await listAllCurrentPaths(ctx.db);
		const filtered = input.prefix ? allPaths.filter((p) => p.startsWith(input.prefix!)) : allPaths;
		return { root: input.prefix ?? "/", tree: buildTree(filtered, input.max_depth) };
	},
});

/**
 * Build a tree of TreeNode objects from a flat list of `/`-delimited paths.
 * Splits each path into segments and groups by common prefix; nodes deeper
 * than `maxDepth` are folded into their parent's `children` summary count.
 */
function buildTree(paths: string[], maxDepth: number): TreeNode[] {
	const root: Map<string, TreeNode> = new Map();
	for (const path of paths) {
		const segs = path.split("/").filter(Boolean);
		let level = root;
		const trail: string[] = [];
		for (let i = 0; i < segs.length && i < maxDepth; i++) {
			const seg = segs[i]!;
			trail.push(seg);
			const fullPath = trail.join("/");
			let node = level.get(seg);
			if (!node) {
				node = { name: seg, full_path: fullPath, is_file: i === segs.length - 1 };
				level.set(seg, node);
			} else if (i === segs.length - 1) {
				node.is_file = true;
			}
			if (i < segs.length - 1) {
				if (!node.children) node.children = [];
				const childMap = new Map(node.children.map((c) => [c.name, c] as const));
				node.children = [...childMap.values()];
				level = childMap;
				if (childMap.size === 0) {
					level = new Map();
					node.children = [];
				} else {
					// rebuild level pointer
					level = new Map(node.children.map((c) => [c.name, c] as const));
				}
			}
		}
	}
	return [...root.values()].sort((a, b) => a.name.localeCompare(b.name));
}
