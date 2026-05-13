import { describe, expect, test } from "bun:test";
import matter from "gray-matter";
import {
	type LinearIssue,
	type LinearProject,
	renderIssue,
	renderProject,
} from "../../../src/ingest/sources/linear-shared.ts";

/** Build a fully-populated issue fixture; tests override specific fields. */
function buildIssue(overrides: Partial<LinearIssue> = {}): LinearIssue {
	return {
		identifier: "ENG-42",
		url: "https://linear.app/acme/issue/ENG-42",
		title: "Fix authentication bug",
		description: "The login flow drops the session token on retry.",
		priorityLabel: "High",
		state: { name: "In Progress" },
		assignee: { displayName: "John Doe", name: "John Doe", email: "john@example.com" },
		creator: { displayName: "Jane Smith", name: "Jane Smith", email: "jane@example.com" },
		createdAt: "2024-01-15T10:00:00.000Z",
		updatedAt: "2024-01-20T15:30:00.000Z",
		dueDate: "2026-06-01",
		estimate: 3,
		team: { key: "ENG", name: "Engineering" },
		project: { name: "Q1 Roadmap", slugId: "q1-roadmap-abc12345" },
		cycle: { number: 14, name: "Cycle 14" },
		labels: { nodes: [{ name: "bug" }, { name: "auth" }] },
		relations: { nodes: [{ type: "blocks", relatedIssue: { identifier: "ENG-99" } }] },
		inverseRelations: { nodes: [{ type: "blocks", issue: { identifier: "ENG-12" } }] },
		comments: { nodes: [] },
		...overrides,
	};
}

describe("renderIssue", () => {
	test("emits YAML frontmatter and parses back into the expected shape", () => {
		const md = renderIssue(buildIssue());
		expect(md.startsWith("---\n")).toBe(true);
		const parsed = matter(md);

		expect(parsed.data.source_url).toBe("https://linear.app/acme/issue/ENG-42");
		expect(parsed.data.identifier).toBe("ENG-42");
		expect(parsed.data.title).toBe("Fix authentication bug");
		expect(parsed.data.state).toBe("In Progress");
		expect(parsed.data.priority).toBe("High");
		expect(parsed.data.assignee).toBe("John Doe <john@example.com>");
		expect(parsed.data.author).toBe("Jane Smith <jane@example.com>");
		expect(parsed.data.team).toBe("ENG");
		expect(parsed.data.project).toBe("Q1 Roadmap");
		expect(parsed.data.cycle).toBe("Cycle 14");
		expect(parsed.data.labels).toEqual(["bug", "auth"]);
		expect(parsed.data.estimate).toBe(3);
		expect(parsed.data.due_date).toBe("2026-06-01");
		expect(parsed.data.blocks).toEqual(["ENG-99"]);
		expect(parsed.data.blocked_by).toEqual(["ENG-12"]);
		expect(parsed.data.created_at).toBe("2024-01-15T10:00:00.000Z");
		expect(parsed.data.updated_at).toBe("2024-01-20T15:30:00.000Z");
	});

	test("body starts with the H1 title", () => {
		const md = renderIssue(buildIssue());
		const parsed = matter(md);
		expect(parsed.content.trimStart().startsWith("# ENG-42: Fix authentication bug")).toBe(true);
	});

	test("omits frontmatter keys for empty/absent fields", () => {
		const md = renderIssue(
			buildIssue({
				assignee: null,
				labels: { nodes: [] },
				relations: { nodes: [] },
				inverseRelations: { nodes: [] },
				dueDate: null,
				estimate: null,
				cycle: null,
				project: null,
			}),
		);
		const parsed = matter(md);
		expect(parsed.data).not.toHaveProperty("assignee");
		expect(parsed.data).not.toHaveProperty("labels");
		expect(parsed.data).not.toHaveProperty("blocks");
		expect(parsed.data).not.toHaveProperty("blocked_by");
		expect(parsed.data).not.toHaveProperty("due_date");
		expect(parsed.data).not.toHaveProperty("estimate");
		expect(parsed.data).not.toHaveProperty("cycle");
		expect(parsed.data).not.toHaveProperty("project");
	});

	test("blocks and blocked_by are derived from relations and inverseRelations with type=blocks only", () => {
		const md = renderIssue(
			buildIssue({
				relations: {
					nodes: [
						{ type: "blocks", relatedIssue: { identifier: "ENG-99" } },
						{ type: "duplicate", relatedIssue: { identifier: "ENG-77" } },
					],
				},
				inverseRelations: {
					nodes: [
						{ type: "blocks", issue: { identifier: "ENG-12" } },
						{ type: "related", issue: { identifier: "ENG-13" } },
					],
				},
			}),
		);
		const parsed = matter(md);
		expect(parsed.data.blocks).toEqual(["ENG-99"]);
		expect(parsed.data.blocked_by).toEqual(["ENG-12"]);
	});

	test("emits the Comments section when comments exist", () => {
		const md = renderIssue(
			buildIssue({
				comments: {
					nodes: [
						{
							body: "Reproduced on staging.",
							createdAt: "2024-01-16T09:00:00.000Z",
							user: { displayName: "Jane", name: "Jane", email: "jane@example.com" },
						},
					],
				},
			}),
		);
		const parsed = matter(md);
		expect(parsed.content).toContain("## Comments (1)");
		expect(parsed.content).toContain("Reproduced on staging.");
	});
});

/** Build a project fixture; tests override specific fields. */
function buildProject(overrides: Partial<LinearProject> = {}): LinearProject {
	return {
		id: "proj-abc",
		url: "https://linear.app/acme/project/q1-roadmap-abc12345",
		name: "Q1 Roadmap",
		slugId: "q1-roadmap-abc12345",
		description: "Critical Q1 features.",
		content: "Detailed plan here.",
		state: "Active",
		startDate: "2024-01-01",
		targetDate: "2024-03-31",
		createdAt: "2023-12-01T00:00:00.000Z",
		updatedAt: "2024-01-20T10:00:00.000Z",
		progress: 0.42,
		lead: { displayName: "Lead Person", name: "Lead Person", email: "lead@example.com" },
		members: {
			nodes: [{ displayName: "Member One", name: "Member One", email: "m1@example.com" }],
		},
		teams: {
			nodes: [
				{ key: "ENG", name: "Engineering" },
				{ key: "DES", name: "Design" },
			],
		},
		...overrides,
	};
}

describe("renderProject", () => {
	test("emits frontmatter with project metadata", () => {
		const md = renderProject(buildProject());
		const parsed = matter(md);
		expect(parsed.data.source_url).toBe("https://linear.app/acme/project/q1-roadmap-abc12345");
		expect(parsed.data.name).toBe("Q1 Roadmap");
		expect(parsed.data.state).toBe("Active");
		expect(parsed.data.lead).toBe("Lead Person <lead@example.com>");
		expect(parsed.data.members).toEqual(["Member One <m1@example.com>"]);
		expect(parsed.data.teams).toEqual(["ENG", "DES"]);
		expect(parsed.data.progress).toBe(0.42);
		expect(parsed.data.start_date).toBe("2024-01-01");
		expect(parsed.data.target_date).toBe("2024-03-31");
	});

	test("body has Summary and Overview sections", () => {
		const md = renderProject(buildProject());
		const parsed = matter(md);
		expect(parsed.content).toContain("# Q1 Roadmap");
		expect(parsed.content).toContain("## Summary");
		expect(parsed.content).toContain("Critical Q1 features.");
		expect(parsed.content).toContain("## Overview");
		expect(parsed.content).toContain("Detailed plan here.");
	});

	test("omits absent optional fields", () => {
		const md = renderProject(
			buildProject({
				lead: null,
				members: { nodes: [] },
				teams: { nodes: [] },
				progress: null,
				startDate: null,
				targetDate: null,
				state: null,
			}),
		);
		const parsed = matter(md);
		expect(parsed.data).not.toHaveProperty("lead");
		expect(parsed.data).not.toHaveProperty("members");
		expect(parsed.data).not.toHaveProperty("teams");
		expect(parsed.data).not.toHaveProperty("progress");
		expect(parsed.data).not.toHaveProperty("start_date");
		expect(parsed.data).not.toHaveProperty("target_date");
		expect(parsed.data).not.toHaveProperty("state");
	});
});
