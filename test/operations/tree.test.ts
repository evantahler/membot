import { describe, expect, test } from "bun:test";
import { buildTree, truncateTree } from "../../src/operations/tree.ts";

describe("buildTree", () => {
	test("groups paths sharing a prefix into a single subtree", () => {
		const tree = buildTree(["docs/a.md", "docs/b.md", "docs/sub/c.md", "readme.md"], 4);
		expect(tree.map((n) => n.name)).toEqual(["docs", "readme.md"]);
		const docs = tree.find((n) => n.name === "docs")!;
		expect(docs.is_file).toBe(false);
		expect(docs.children?.map((c) => c.name)).toEqual(["a.md", "b.md", "sub"]);
		const sub = docs.children?.find((c) => c.name === "sub");
		expect(sub?.children?.map((c) => c.name)).toEqual(["c.md"]);
	});

	test("respects max_depth by dropping deeper segments", () => {
		const tree = buildTree(["a/b/c/d.md"], 2);
		expect(tree[0]?.name).toBe("a");
		expect(tree[0]?.children?.[0]?.name).toBe("b");
		expect(tree[0]?.children?.[0]?.children).toBeUndefined();
	});

	test("marks a node as both directory and file when one path is a prefix of another", () => {
		const tree = buildTree(["docs", "docs/a.md"], 4);
		const docs = tree.find((n) => n.name === "docs")!;
		expect(docs.is_file).toBe(true);
		expect(docs.children?.map((c) => c.name)).toEqual(["a.md"]);
	});

	test("ignores empty path inputs", () => {
		const tree = buildTree(["", "/", "a.md"], 4);
		expect(tree.map((n) => n.name)).toEqual(["a.md"]);
	});
});

describe("truncateTree", () => {
	test("trims root to max_items and reports the dropped count", () => {
		const nodes = ["a", "b", "c", "d"].map((n) => ({ name: n, full_path: n, is_file: true }));
		const dropped = truncateTree(nodes, 2);
		expect(dropped).toBe(2);
		expect(nodes.map((n) => n.name)).toEqual(["a", "b"]);
	});

	test("trims nested children and records children_truncated on the parent", () => {
		const tree = buildTree(["docs/a.md", "docs/b.md", "docs/c.md", "docs/d.md", "docs/e.md"], 4);
		truncateTree(tree, 2);
		const docs = tree.find((n) => n.name === "docs")!;
		expect(docs.children?.map((c) => c.name)).toEqual(["a.md", "b.md"]);
		expect(docs.children_truncated).toBe(3);
	});

	test("does nothing when nodes.length <= max_items", () => {
		const nodes = ["a", "b"].map((n) => ({ name: n, full_path: n, is_file: true }));
		const dropped = truncateTree(nodes, 5);
		expect(dropped).toBe(0);
		expect(nodes).toHaveLength(2);
		expect(nodes[0]).not.toHaveProperty("children_truncated");
	});

	test("truncation order is deterministic (alphabetical, since buildTree sorts)", () => {
		const tree = buildTree(["zeta", "alpha", "mu", "beta"], 4);
		truncateTree(tree, 2);
		expect(tree.map((n) => n.name)).toEqual(["alpha", "beta"]);
	});
});
