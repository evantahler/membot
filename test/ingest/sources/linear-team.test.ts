import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MembotConfigSchema } from "../../../src/config/schemas.ts";
import { openDb } from "../../../src/db/connection.ts";
import { insertVersion } from "../../../src/db/files.ts";
import "../../../src/ingest/sources/index.ts";
import { linearTeamPlugin, parseLinearTeamScope } from "../../../src/ingest/sources/linear-team.ts";
import { logger } from "../../../src/output/logger.ts";

interface MockResponseInit {
	status?: number;
	headers?: Record<string, string>;
}

function jsonResponse(body: unknown, init: MockResponseInit = {}): Response {
	return new Response(JSON.stringify(body), {
		status: init.status ?? 200,
		headers: { "content-type": "application/json", ...(init.headers ?? {}) },
	});
}

interface RecordedCall {
	url: string;
	body: { query: string; variables: Record<string, unknown> };
}

/**
 * Install a `globalThis.fetch` stub that responds to Linear's GraphQL
 * endpoint by dispatching on the query's leading `query Name(` token.
 * Returns the recorded call list so tests can assert pagination + variables.
 */
function installLinearFetch(handlers: Record<string, (vars: Record<string, unknown>) => Response>): {
	calls: RecordedCall[];
	restore: () => void;
} {
	const original = globalThis.fetch;
	const calls: RecordedCall[] = [];
	globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		const body = JSON.parse(String(init?.body ?? "{}")) as { query: string; variables: Record<string, unknown> };
		calls.push({ url, body });
		const head = body.query.match(/query\s+(\w+)/)?.[1] ?? "";
		const handler = handlers[head];
		if (!handler) return jsonResponse({ data: null, errors: [{ message: `no handler for ${head}` }] }, { status: 500 });
		return handler(body.variables);
	}) as unknown as typeof globalThis.fetch;
	return {
		calls,
		restore: () => {
			globalThis.fetch = original;
		},
	};
}

const configWithKey = MembotConfigSchema.parse({
	downloaders: { linear: { api_key: "lin_api_test" } },
});
const configNoKey = MembotConfigSchema.parse({});

describe("parseLinearTeamScope", () => {
	test("accepts uppercase team keys", () => {
		expect(parseLinearTeamScope("linear-team:ENG")).toEqual({ team: "ENG" });
		expect(parseLinearTeamScope("linear-team:DESIGN_2")).toEqual({ team: "DESIGN_2" });
	});

	test("rejects empty key", () => {
		expect(() => parseLinearTeamScope("linear-team:")).toThrow(/no team key/);
	});

	test("rejects lowercase / invalid chars", () => {
		expect(() => parseLinearTeamScope("linear-team:eng")).toThrow(/uppercase/);
		expect(() => parseLinearTeamScope("linear-team:ENG-X")).toThrow(/uppercase/);
	});

	test("rejects non-scheme sources", () => {
		expect(() => parseLinearTeamScope("https://linear.app/x")).toThrow(/not a linear-team source/);
	});
});

describe("linearTeamPlugin.enumerate", () => {
	let restoreFetch: () => void;

	afterEach(() => {
		restoreFetch?.();
	});

	test("paginates projects + issues and emits nested entries", async () => {
		const stub = installLinearFetch({
			TeamByKey: () =>
				jsonResponse({
					data: {
						teams: {
							nodes: [
								{
									id: "team-1",
									key: "ENG",
									organization: { urlKey: "arcade" },
									children: { nodes: [] },
								},
							],
						},
					},
				}),
			ProjectsForTeams: (vars) => {
				if (!vars.after) {
					return jsonResponse({
						data: {
							projects: {
								pageInfo: { hasNextPage: true, endCursor: "p-cursor-1" },
								nodes: [
									{
										id: "p1",
										name: "Alpha",
										slugId: "alpha-abc12345",
										url: "https://linear.app/arcade/project/alpha-abc12345",
										updatedAt: "2026-01-01T00:00:00Z",
									},
								],
							},
						},
					});
				}
				return jsonResponse({
					data: {
						projects: {
							pageInfo: { hasNextPage: false, endCursor: null },
							nodes: [
								{
									id: "p2",
									name: "Beta",
									slugId: "beta-def67890",
									url: "https://linear.app/arcade/project/beta-def67890",
									updatedAt: "2026-01-02T00:00:00Z",
								},
							],
						},
					},
				});
			},
			IssuesForProject: (vars) => {
				const projectId = vars.projectId as string;
				return jsonResponse({
					data: {
						issues: {
							pageInfo: { hasNextPage: false, endCursor: null },
							nodes: [
								{
									id: `${projectId}-i1`,
									identifier: projectId === "p1" ? "ENG-1" : "ENG-2",
									title: "T",
									url: `https://linear.app/arcade/issue/${projectId === "p1" ? "ENG-1" : "ENG-2"}`,
									updatedAt: "2026-01-05T00:00:00Z",
								},
							],
						},
					},
				});
			},
		});
		restoreFetch = stub.restore;

		const entries = await linearTeamPlugin.enumerate("linear-team:ENG", { config: configWithKey, logger });
		// 2 projects + 2 issues = 4 entries, in the order [project, issue, project, issue].
		expect(entries).toHaveLength(4);
		expect(entries[0]?.cursor.kind).toBe("project");
		expect(entries[0]?.logicalPathHint).toBe("linear/arcade/projects/alpha-abc12345.md");
		expect(entries[1]?.cursor.kind).toBe("issue");
		expect(entries[1]?.logicalPathHint).toBe("linear/arcade/issues/ENG-1.md");
		expect(entries[2]?.cursor.kind).toBe("project");
		expect(entries[3]?.logicalPathHint).toBe("linear/arcade/issues/ENG-2.md");

		const projectsCalls = stub.calls.filter((c) => c.body.query.includes("ProjectsForTeams"));
		expect(projectsCalls).toHaveLength(2);
		expect(projectsCalls[0]?.body.variables.after).toBeNull();
		expect(projectsCalls[1]?.body.variables.after).toBe("p-cursor-1");
		expect(projectsCalls[0]?.body.variables.teamIds).toEqual(["team-1"]);
	});

	test("includes one level of sub-team projects (deduped)", async () => {
		const stub = installLinearFetch({
			TeamByKey: () =>
				jsonResponse({
					data: {
						teams: {
							nodes: [
								{
									id: "team-parent",
									key: "ENG",
									organization: { urlKey: "arcade" },
									children: {
										nodes: [
											{ id: "team-child-1", key: "ENG_PLATFORM" },
											{ id: "team-child-2", key: "ENG_INFRA" },
										],
									},
								},
							],
						},
					},
				}),
			ProjectsForTeams: () =>
				jsonResponse({
					data: {
						projects: {
							pageInfo: { hasNextPage: false, endCursor: null },
							nodes: [
								// Same project id appears twice (shared by parent + sub-team) — dedupe.
								{
									id: "p1",
									name: "Shared",
									slugId: "shared-abc12345",
									url: "https://linear.app/arcade/project/shared-abc12345",
									updatedAt: "2026-01-01T00:00:00Z",
								},
								{
									id: "p1",
									name: "Shared",
									slugId: "shared-abc12345",
									url: "https://linear.app/arcade/project/shared-abc12345",
									updatedAt: "2026-01-01T00:00:00Z",
								},
								// Sub-team-only project.
								{
									id: "p2",
									name: "Platform only",
									slugId: "platform-def67890",
									url: "https://linear.app/arcade/project/platform-def67890",
									updatedAt: "2026-01-02T00:00:00Z",
								},
							],
						},
					},
				}),
			IssuesForProject: () =>
				jsonResponse({
					data: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } },
				}),
		});
		restoreFetch = stub.restore;

		const entries = await linearTeamPlugin.enumerate("linear-team:ENG", { config: configWithKey, logger });
		// 2 distinct projects (after dedupe) + 0 issues = 2 entries.
		expect(entries).toHaveLength(2);
		expect(entries.map((e) => e.logicalPathHint).sort()).toEqual([
			"linear/arcade/projects/platform-def67890.md",
			"linear/arcade/projects/shared-abc12345.md",
		]);
		const projectsCalls = stub.calls.filter((c) => c.body.query.includes("ProjectsForTeams"));
		expect(projectsCalls[0]?.body.variables.teamIds).toEqual(["team-parent", "team-child-1", "team-child-2"]);
	});

	test("raises auth_error when api_key is missing", async () => {
		await expect(linearTeamPlugin.enumerate("linear-team:ENG", { config: configNoKey, logger })).rejects.toMatchObject({
			kind: "auth_error",
		});
	});

	test("raises not_found when team doesn't exist", async () => {
		const stub = installLinearFetch({
			TeamByKey: () => jsonResponse({ data: { teams: { nodes: [] } } }),
		});
		restoreFetch = stub.restore;
		await expect(
			linearTeamPlugin.enumerate("linear-team:NOPE", { config: configWithKey, logger }),
		).rejects.toMatchObject({ kind: "not_found" });
	});
});

describe("linearTeamPlugin.rehydrateEntry", () => {
	test("issue rehydrates to the canonical issue path", () => {
		const e = linearTeamPlugin.rehydrateEntry("https://linear.app/arcade/issue/ENG-42", {
			kind: "issue",
			team: "ENG",
			workspace: "arcade",
			identifier: "ENG-42",
		});
		expect(e.logicalPathHint).toBe("linear/arcade/issues/ENG-42.md");
		expect(e.cursor.kind).toBe("issue");
	});

	test("project rehydrates to the canonical project path", () => {
		const e = linearTeamPlugin.rehydrateEntry("https://linear.app/arcade/project/x-abc12345", {
			kind: "project",
			team: "ENG",
			workspace: "arcade",
			slug: "x-abc12345",
			slug_id: "abc12345",
			project_id: "p-1",
		});
		expect(e.logicalPathHint).toBe("linear/arcade/projects/x-abc12345.md");
	});
});

describe("linearTeamPlugin.probeUnchanged", () => {
	test("returns true when mtimes match", () => {
		const entry = {
			source: "x",
			logicalPathHint: "x",
			cursor: { kind: "issue", team: "ENG", workspace: "arcade", identifier: "ENG-1" } as const,
			mtimeMs: 1_000,
		};
		expect(linearTeamPlugin.probeUnchanged?.(entry, { source_mtime_ms: 1_000, source_sha256: null })).toBe(true);
		expect(linearTeamPlugin.probeUnchanged?.(entry, { source_mtime_ms: 999, source_sha256: null })).toBe(false);
		expect(linearTeamPlugin.probeUnchanged?.(entry, { source_mtime_ms: null, source_sha256: null })).toBe(false);
	});
});

describe("linearTeamPlugin.sync", () => {
	let tmp: string;
	let dbPath: string;
	let restoreFetch: () => void;

	beforeEach(async () => {
		tmp = mkdtempSync(join(tmpdir(), "membot-lt-sync-"));
		dbPath = join(tmp, "index.duckdb");
	});

	afterEach(async () => {
		restoreFetch?.();
		rmSync(tmp, { recursive: true, force: true });
	});

	test("tombstones only stale linear-team rows matching the team", async () => {
		const db = await openDb(dbPath);

		// Seed: ENG-1 alive, ENG-2 stale (deleted), alpha-abc12345 alive,
		// beta-def67890 stale, FOO-1 wrong team, and ENG-3 owned by per-URL
		// linear plugin (must not be tombstoned).
		await insertVersion(db, {
			logical_path: "linear/arcade/issues/ENG-1.md",
			source_type: "remote",
			content: "x",
			downloader: "linear-team",
			downloader_args: { kind: "issue", team: "ENG", workspace: "arcade", identifier: "ENG-1" },
		});
		await insertVersion(db, {
			logical_path: "linear/arcade/issues/ENG-2.md",
			source_type: "remote",
			content: "x",
			downloader: "linear-team",
			downloader_args: { kind: "issue", team: "ENG", workspace: "arcade", identifier: "ENG-2" },
		});
		await insertVersion(db, {
			logical_path: "linear/arcade/projects/alpha-abc12345.md",
			source_type: "remote",
			content: "x",
			downloader: "linear-team",
			downloader_args: {
				kind: "project",
				team: "ENG",
				workspace: "arcade",
				slug: "alpha-abc12345",
				slug_id: "alpha-abc12345",
				project_id: "p1",
			},
		});
		await insertVersion(db, {
			logical_path: "linear/arcade/projects/beta-def67890.md",
			source_type: "remote",
			content: "x",
			downloader: "linear-team",
			downloader_args: {
				kind: "project",
				team: "ENG",
				workspace: "arcade",
				slug: "beta-def67890",
				slug_id: "beta-def67890",
				project_id: "p2",
			},
		});
		await insertVersion(db, {
			logical_path: "linear/arcade/issues/FOO-1.md",
			source_type: "remote",
			content: "x",
			downloader: "linear-team",
			downloader_args: { kind: "issue", team: "FOO", workspace: "arcade", identifier: "FOO-1" },
		});
		await insertVersion(db, {
			logical_path: "linear/arcade/issues/ENG-3.md",
			source_type: "remote",
			content: "x",
			downloader: "linear",
			downloader_args: { kind: "issue", workspace: "arcade", identifier: "ENG-3" },
		});

		const stub = installLinearFetch({
			TeamByKey: () =>
				jsonResponse({
					data: {
						teams: {
							nodes: [
								{
									id: "team-1",
									key: "ENG",
									organization: { urlKey: "arcade" },
									children: { nodes: [] },
								},
							],
						},
					},
				}),
			ProjectsForTeams: () =>
				jsonResponse({
					data: {
						projects: {
							pageInfo: { hasNextPage: false, endCursor: null },
							nodes: [
								{
									id: "p1",
									name: "Alpha",
									slugId: "alpha-abc12345",
									url: "https://linear.app/arcade/project/alpha-abc12345",
									updatedAt: "2026-01-01T00:00:00Z",
								},
							],
						},
					},
				}),
			IssuesForProject: () =>
				jsonResponse({
					data: {
						issues: {
							pageInfo: { hasNextPage: false, endCursor: null },
							nodes: [
								{
									id: "i1",
									identifier: "ENG-1",
									title: "T",
									url: "https://linear.app/arcade/issue/ENG-1",
									updatedAt: "2026-01-05T00:00:00Z",
								},
							],
						},
					},
				}),
		});
		restoreFetch = stub.restore;

		const result = await linearTeamPlugin.sync!({ db, config: configWithKey, logger }, "linear-team:ENG");
		expect(result.tombstoned.sort()).toEqual([
			"linear/arcade/issues/ENG-2.md",
			"linear/arcade/projects/beta-def67890.md",
		]);
		await db.close();
	});
});
