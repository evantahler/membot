import { describe, expect, test } from "bun:test";
import matter from "gray-matter";
import {
	type GithubComment,
	type GithubIssue,
	type GithubTimelineEvent,
	renderIssue,
} from "../../../src/ingest/sources/github-shared.ts";

/** Build a fully-populated issue fixture; tests override specific fields. */
function buildIssue(overrides: Partial<GithubIssue> = {}): GithubIssue {
	return {
		number: 123,
		title: "Fix bug in authentication",
		body: "The auth flow drops the session token.",
		state: "open",
		html_url: "https://github.com/acme/widget/issues/123",
		user: { login: "octocat" },
		assignees: [{ login: "user1" }, { login: "user2" }],
		labels: [{ name: "bug" }, { name: "urgent" }],
		milestone: { title: "v1.2.0", due_on: "2026-06-01T00:00:00Z" },
		created_at: "2024-01-15T10:00:00Z",
		updated_at: "2024-01-20T15:30:00Z",
		closed_at: null,
		...overrides,
	};
}

describe("renderIssue (GitHub issue)", () => {
	test("emits frontmatter with metadata and parses back into the expected shape", () => {
		const md = renderIssue(buildIssue(), [], [], false);
		expect(md.startsWith("---\n")).toBe(true);
		const parsed = matter(md);

		expect(parsed.data.source_url).toBe("https://github.com/acme/widget/issues/123");
		expect(parsed.data.number).toBe(123);
		expect(parsed.data.kind).toBe("issue");
		expect(parsed.data.title).toBe("Fix bug in authentication");
		expect(parsed.data.state).toBe("open");
		expect(parsed.data.author).toBe("octocat");
		expect(parsed.data.assignees).toEqual(["user1", "user2"]);
		expect(parsed.data.labels).toEqual(["bug", "urgent"]);
		expect(parsed.data.milestone).toBe("v1.2.0");
		expect(parsed.data.due_date).toBe("2026-06-01T00:00:00Z");
		expect(parsed.data.created_at).toBe("2024-01-15T10:00:00Z");
		expect(parsed.data.updated_at).toBe("2024-01-20T15:30:00Z");
	});

	test("issue payload does NOT emit a draft key", () => {
		const md = renderIssue(buildIssue(), [], [], false);
		const parsed = matter(md);
		expect(parsed.data).not.toHaveProperty("draft");
	});

	test("milestone without due_on omits due_date", () => {
		const md = renderIssue(buildIssue({ milestone: { title: "Backlog", due_on: null } }), [], [], false);
		const parsed = matter(md);
		expect(parsed.data.milestone).toBe("Backlog");
		expect(parsed.data).not.toHaveProperty("due_date");
	});

	test("absent milestone omits both milestone and due_date", () => {
		const md = renderIssue(buildIssue({ milestone: null }), [], [], false);
		const parsed = matter(md);
		expect(parsed.data).not.toHaveProperty("milestone");
		expect(parsed.data).not.toHaveProperty("due_date");
	});

	test("closed issue emits closed_at", () => {
		const md = renderIssue(buildIssue({ state: "closed", closed_at: "2024-01-21T12:00:00Z" }), [], [], false);
		const parsed = matter(md);
		expect(parsed.data.state).toBe("closed");
		expect(parsed.data.closed_at).toBe("2024-01-21T12:00:00Z");
	});

	test("empty assignees and labels omit those keys", () => {
		const md = renderIssue(buildIssue({ assignees: [], labels: [] }), [], [], false);
		const parsed = matter(md);
		expect(parsed.data).not.toHaveProperty("assignees");
		expect(parsed.data).not.toHaveProperty("labels");
	});

	test("body contains the H1 and Comments section when comments exist", () => {
		const comments: GithubComment[] = [
			{ body: "Reproduced.", user: { login: "bob" }, created_at: "2024-01-16T09:00:00Z" },
		];
		const md = renderIssue(buildIssue(), comments, [], false);
		const parsed = matter(md);
		expect(parsed.content).toContain("# Issue #123: Fix bug in authentication");
		expect(parsed.content).toContain("## Comments (1)");
		expect(parsed.content).toContain("@bob");
		expect(parsed.content).toContain("Reproduced.");
	});

	test("references are derived from cross-referenced timeline events, deduped, sorted", () => {
		const timeline: GithubTimelineEvent[] = [
			{ event: "cross-referenced", source: { issue: { number: 42 } } },
			{ event: "cross-referenced", source: { issue: { number: 99 } } },
			{ event: "cross-referenced", source: { issue: { number: 42 } } },
			{ event: "labeled" },
		];
		const md = renderIssue(buildIssue(), [], timeline, false);
		const parsed = matter(md);
		expect(parsed.data.references).toEqual([42, 99]);
	});
});

describe("renderIssue (GitHub PR)", () => {
	test("PR emits kind=pull and the draft key", () => {
		const md = renderIssue(buildIssue({ draft: true }), [], [], true);
		const parsed = matter(md);
		expect(parsed.data.kind).toBe("pull");
		expect(parsed.data.draft).toBe(true);
	});

	test("PR emits H1 with 'PR #N:' prefix", () => {
		const md = renderIssue(buildIssue(), [], [], true);
		const parsed = matter(md);
		expect(parsed.content).toContain("# PR #123:");
	});

	test("closes is derived from connected timeline events on PRs only", () => {
		const timeline: GithubTimelineEvent[] = [
			{ event: "connected", subject: { number: 41 } },
			{ event: "connected", subject: { number: 50 } },
			{ event: "cross-referenced", source: { issue: { number: 99 } } },
		];
		const md = renderIssue(buildIssue(), [], timeline, true);
		const parsed = matter(md);
		expect(parsed.data.closes).toEqual([41, 50]);
		expect(parsed.data.references).toEqual([99]);
	});

	test("issues never emit closes even with connected timeline events", () => {
		const timeline: GithubTimelineEvent[] = [{ event: "connected", subject: { number: 41 } }];
		const md = renderIssue(buildIssue(), [], timeline, false);
		const parsed = matter(md);
		expect(parsed.data).not.toHaveProperty("closes");
	});
});
