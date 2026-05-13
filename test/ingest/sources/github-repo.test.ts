import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MembotConfigSchema } from "../../../src/config/schemas.ts";
import { openDb } from "../../../src/db/connection.ts";
import { insertVersion } from "../../../src/db/files.ts";
import { githubRepoPlugin, parseGithubRepoScope } from "../../../src/ingest/sources/github-repo.ts";
import "../../../src/ingest/sources/index.ts";
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

/**
 * Install a `globalThis.fetch` stub matching on URL path. Returns the
 * recorded URLs so tests can assert pagination + state filters.
 */
function installGithubFetch(responder: (url: URL) => Response): { calls: string[]; restore: () => void } {
	const original = globalThis.fetch;
	const calls: string[] = [];
	globalThis.fetch = mock(async (input: string | URL | Request) => {
		const url = typeof input === "string" ? new URL(input) : input instanceof URL ? input : new URL(input.url);
		calls.push(url.toString());
		return responder(url);
	}) as unknown as typeof globalThis.fetch;
	return {
		calls,
		restore: () => {
			globalThis.fetch = original;
		},
	};
}

const configEmpty = MembotConfigSchema.parse({});

describe("parseGithubRepoScope", () => {
	test("default selector pulls open issues + prs", () => {
		expect(parseGithubRepoScope("github-repo:cli/cli")).toEqual({
			owner: "cli",
			repo: "cli",
			include: { issues: true, prs: true },
			state: "open",
		});
	});

	test("issues / prs / *:all variants", () => {
		expect(parseGithubRepoScope("github-repo:o/r:issues").include).toEqual({ issues: true, prs: false });
		expect(parseGithubRepoScope("github-repo:o/r:prs").include).toEqual({ issues: false, prs: true });
		expect(parseGithubRepoScope("github-repo:o/r:issues:all").state).toBe("all");
		expect(parseGithubRepoScope("github-repo:o/r:prs:all").state).toBe("all");
		const all = parseGithubRepoScope("github-repo:o/r:all");
		expect(all.include).toEqual({ issues: true, prs: true });
		expect(all.state).toBe("all");
	});

	test("rejects malformed scopes", () => {
		expect(() => parseGithubRepoScope("github-repo:")).toThrow(/not a valid github-repo source/);
		expect(() => parseGithubRepoScope("github-repo:foo")).toThrow(/not a valid github-repo source/);
		expect(() => parseGithubRepoScope("github-repo:o/r:bogus")).toThrow(/not a valid github-repo source/);
	});
});

describe("githubRepoPlugin.enumerate", () => {
	let restoreFetch: () => void;

	afterEach(() => {
		restoreFetch?.();
		delete process.env.GITHUB_TOKEN;
	});

	test("default selector mixes issues + PRs and stops when page < 100", async () => {
		const stub = installGithubFetch((url) => {
			expect(url.searchParams.get("state")).toBe("open");
			const page = Number(url.searchParams.get("page") ?? "1");
			if (page === 1) {
				return jsonResponse([
					{ number: 1, html_url: "https://github.com/o/r/issues/1", updated_at: "2026-01-01T00:00:00Z" },
					{
						number: 2,
						html_url: "https://github.com/o/r/pull/2",
						updated_at: "2026-01-02T00:00:00Z",
						pull_request: {},
					},
				]);
			}
			return jsonResponse([]);
		});
		restoreFetch = stub.restore;
		const entries = await githubRepoPlugin.enumerate("github-repo:o/r", { config: configEmpty, logger });
		expect(entries).toHaveLength(2);
		expect(entries[0]?.logicalPathHint).toBe("github/o/r/issues/1.md");
		expect(entries[0]?.cursor.kind).toBe("issues");
		expect(entries[1]?.logicalPathHint).toBe("github/o/r/pulls/2.md");
		expect(entries[1]?.cursor.kind).toBe("pull");
	});

	test(":issues selector filters out PRs client-side", async () => {
		const stub = installGithubFetch(() =>
			jsonResponse([
				{ number: 1, html_url: "https://github.com/o/r/issues/1", updated_at: "2026-01-01T00:00:00Z" },
				{ number: 2, html_url: "https://github.com/o/r/pull/2", updated_at: "2026-01-02T00:00:00Z", pull_request: {} },
			]),
		);
		restoreFetch = stub.restore;
		const entries = await githubRepoPlugin.enumerate("github-repo:o/r:issues", { config: configEmpty, logger });
		expect(entries).toHaveLength(1);
		expect(entries[0]?.cursor.kind).toBe("issues");
	});

	test(":all selector requests state=all", async () => {
		let sawAll = false;
		const stub = installGithubFetch((url) => {
			if (url.searchParams.get("state") === "all") sawAll = true;
			return jsonResponse([]);
		});
		restoreFetch = stub.restore;
		await githubRepoPlugin.enumerate("github-repo:o/r:all", { config: configEmpty, logger });
		expect(sawAll).toBe(true);
	});

	test("404 → not_found HelpfulError", async () => {
		const stub = installGithubFetch(() => new Response("", { status: 404 }));
		restoreFetch = stub.restore;
		await expect(githubRepoPlugin.enumerate("github-repo:o/r", { config: configEmpty, logger })).rejects.toMatchObject({
			kind: "not_found",
		});
	});

	test("rate-limit 403 with remaining=0 → network_error with reset hint", async () => {
		const stub = installGithubFetch(
			() =>
				new Response("", {
					status: 403,
					headers: {
						"x-ratelimit-remaining": "0",
						"x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 60),
					},
				}),
		);
		restoreFetch = stub.restore;
		await expect(githubRepoPlugin.enumerate("github-repo:o/r", { config: configEmpty, logger })).rejects.toMatchObject({
			kind: "network_error",
			hint: expect.stringMatching(/rate|token/i),
		});
	});
});

describe("githubRepoPlugin.rehydrateEntry", () => {
	test("issue rehydrates to canonical path", () => {
		const e = githubRepoPlugin.rehydrateEntry("https://github.com/o/r/issues/7", {
			owner: "o",
			repo: "r",
			kind: "issues",
			number: 7,
		});
		expect(e.logicalPathHint).toBe("github/o/r/issues/7.md");
	});

	test("PR rehydrates to /pulls/", () => {
		const e = githubRepoPlugin.rehydrateEntry("https://github.com/o/r/pull/9", {
			owner: "o",
			repo: "r",
			kind: "pull",
			number: 9,
		});
		expect(e.logicalPathHint).toBe("github/o/r/pulls/9.md");
	});
});

describe("githubRepoPlugin.probeUnchanged", () => {
	test("mtime equality gates fetch", () => {
		const entry = {
			source: "x",
			logicalPathHint: "x",
			cursor: { owner: "o", repo: "r", kind: "issues" as const, number: 1 },
			mtimeMs: 5,
		};
		expect(githubRepoPlugin.probeUnchanged?.(entry, { source_mtime_ms: 5, source_sha256: null })).toBe(true);
		expect(githubRepoPlugin.probeUnchanged?.(entry, { source_mtime_ms: 4, source_sha256: null })).toBe(false);
	});
});

describe("githubRepoPlugin.sync", () => {
	let tmp: string;
	let restoreFetch: () => void;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "membot-gr-sync-"));
	});

	afterEach(() => {
		restoreFetch?.();
		rmSync(tmp, { recursive: true, force: true });
	});

	test("tombstones only stale github-repo rows matching the repo", async () => {
		const db = await openDb(join(tmp, "index.duckdb"));

		// Seed: #1 alive, #2 stale, PR #3 alive, PR #4 stale, foreign-repo #5,
		// per-URL github row #6 (must be left alone).
		await insertVersion(db, {
			logical_path: "github/o/r/issues/1.md",
			source_type: "remote",
			content: "x",
			downloader: "github-repo",
			downloader_args: { owner: "o", repo: "r", kind: "issues", number: 1 },
		});
		await insertVersion(db, {
			logical_path: "github/o/r/issues/2.md",
			source_type: "remote",
			content: "x",
			downloader: "github-repo",
			downloader_args: { owner: "o", repo: "r", kind: "issues", number: 2 },
		});
		await insertVersion(db, {
			logical_path: "github/o/r/pulls/3.md",
			source_type: "remote",
			content: "x",
			downloader: "github-repo",
			downloader_args: { owner: "o", repo: "r", kind: "pull", number: 3 },
		});
		await insertVersion(db, {
			logical_path: "github/o/r/pulls/4.md",
			source_type: "remote",
			content: "x",
			downloader: "github-repo",
			downloader_args: { owner: "o", repo: "r", kind: "pull", number: 4 },
		});
		await insertVersion(db, {
			logical_path: "github/other/repo/issues/5.md",
			source_type: "remote",
			content: "x",
			downloader: "github-repo",
			downloader_args: { owner: "other", repo: "repo", kind: "issues", number: 5 },
		});
		await insertVersion(db, {
			logical_path: "github/o/r/issues/6.md",
			source_type: "remote",
			content: "x",
			downloader: "github",
			downloader_args: { owner: "o", repo: "r", kind: "issues", number: 6 },
		});

		const stub = installGithubFetch(() =>
			jsonResponse([
				{ number: 1, html_url: "https://github.com/o/r/issues/1", updated_at: "2026-01-01T00:00:00Z" },
				{ number: 3, html_url: "https://github.com/o/r/pull/3", updated_at: "2026-01-02T00:00:00Z", pull_request: {} },
			]),
		);
		restoreFetch = stub.restore;

		const result = await githubRepoPlugin.sync!({ db, config: configEmpty, logger }, "github-repo:o/r");
		expect(result.tombstoned.sort()).toEqual(["github/o/r/issues/2.md", "github/o/r/pulls/4.md"]);
		await db.close();
	});
});
