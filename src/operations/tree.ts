import { z } from "zod";
import { listAllCurrentPaths } from "../db/files.ts";
import { colors } from "../output/formatter.ts";
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
	console_formatter: (result) => {
		const lines: string[] = [colors.bold(result.root)];
		const nodes = result.tree as TreeNode[];
		renderNodes(nodes, "", lines);
		if (lines.length === 1) lines.push(colors.dim("(empty)"));
		return lines.join("\n");
	},
	handler: async (input, ctx) => {
		const allPaths = await listAllCurrentPaths(ctx.db);
		const filtered = input.prefix ? allPaths.filter((p) => p.startsWith(input.prefix!)) : allPaths;
		return { root: input.prefix ?? "/", tree: buildTree(filtered, input.max_depth) };
	},
});

/**
 * Build a tree of TreeNode objects from a flat list of `/`-delimited paths.
 * Splits each path into segments and groups by common prefix. Segments
 * deeper than `maxDepth` are folded into the deepest visible ancestor —
 * that ancestor is marked `is_file=true` so the renderer surfaces it as a
 * leaf even though longer paths exist underneath.
 */
function buildTree(paths: string[], maxDepth: number): TreeNode[] {
	interface MutableNode {
		name: string;
		full_path: string;
		is_file: boolean;
		children: Map<string, MutableNode>;
	}
	const root = new Map<string, MutableNode>();
	for (const path of paths) {
		const segs = path.split("/").filter(Boolean);
		if (segs.length === 0) continue;
		let level = root;
		const trail: string[] = [];
		const stop = Math.min(segs.length, maxDepth);
		for (let i = 0; i < stop; i++) {
			const seg = segs[i]!;
			trail.push(seg);
			let node = level.get(seg);
			if (!node) {
				node = { name: seg, full_path: trail.join("/"), is_file: false, children: new Map() };
				level.set(seg, node);
			}
			const isTerminal = i === segs.length - 1 || i === maxDepth - 1;
			if (isTerminal) node.is_file = true;
			level = node.children;
		}
	}
	const finalize = (m: Map<string, MutableNode>): TreeNode[] => {
		const arr = [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
		return arr.map((n) => {
			const out: TreeNode = { name: n.name, full_path: n.full_path, is_file: n.is_file };
			if (n.children.size > 0) out.children = finalize(n.children);
			return out;
		});
	};
	return finalize(root);
}

/**
 * Walk a tree and append `├── name` / `└── name` lines with proper continuation
 * prefixes. Directories are rendered in cyan-bold; files in plain text.
 */
function renderNodes(nodes: TreeNode[], prefix: string, out: string[]): void {
	const sorted = [...nodes].sort((a, b) => a.name.localeCompare(b.name));
	sorted.forEach((node, i) => {
		const last = i === sorted.length - 1;
		const branch = last ? "└── " : "├── ";
		const label = node.is_file && !node.children?.length ? node.name : colors.cyan(colors.bold(node.name));
		out.push(`${prefix}${branch}${label}`);
		if (node.children?.length) {
			renderNodes(node.children, prefix + (last ? "    " : "│   "), out);
		}
	});
}
