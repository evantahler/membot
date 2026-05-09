import { afterEach, describe, expect, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { MembotConfigSchema } from "../../src/config/schemas.ts";
import { type AgentMcpxAdapter, agentFetch } from "../../src/ingest/agent-fetcher.ts";
import { logger } from "../../src/output/logger.ts";
import { setMode } from "../../src/output/tty.ts";

const baseLlm = { ...MembotConfigSchema.parse({}).llm, anthropic_api_key: "test-key" };

interface CapturedLogs {
	info: string[];
	debug: string[];
	warn: string[];
	error: string[];
}

/**
 * Capture logger output for a test. Forces a non-silent, non-json mode so
 * info() actually fires, then patches the four log methods to record calls.
 * Returns a teardown that restores everything.
 */
function captureLogs(verbose: boolean): { logs: CapturedLogs; restore: () => void } {
	setMode({ interactive: false, color: false, json: false, verbose, silent: false });
	const logs: CapturedLogs = { info: [], debug: [], warn: [], error: [] };
	const orig = {
		info: logger.info.bind(logger),
		debug: logger.debug.bind(logger),
		warn: logger.warn.bind(logger),
		error: logger.error.bind(logger),
	};
	logger.info = (m: string) => logs.info.push(m);
	logger.debug = (m: string) => {
		if (verbose) logs.debug.push(m);
	};
	logger.warn = (m: string) => logs.warn.push(m);
	logger.error = (m: string) => logs.error.push(m);
	return {
		logs,
		restore() {
			logger.info = orig.info;
			logger.debug = orig.debug;
			logger.warn = orig.warn;
			logger.error = orig.error;
			setMode({ interactive: false, color: false, json: false, verbose: false, silent: true });
		},
	};
}

interface MockResponse {
	content: Array<
		{ type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
	>;
	stop_reason: "tool_use" | "end_turn" | "max_tokens";
}

/** Build a fake Anthropic client that returns scripted responses per call. */
function fakeClient(scripted: MockResponse[]): Anthropic {
	let i = 0;
	return {
		messages: {
			create: async () => {
				const r = scripted[i];
				i++;
				if (!r) throw new Error(`fakeClient ran out of scripted responses at call ${i}`);
				return r;
			},
		},
	} as unknown as Anthropic;
}

/** Stub mcpx adapter with configurable exec/search behavior. */
function makeMcpxStub(
	execImpl?: (server: string, tool: string, args: Record<string, unknown>) => unknown,
): AgentMcpxAdapter {
	return {
		async search() {
			return [{ server: "linear", tool: "get_project", description: "", score: 0.9 }];
		},
		async listTools() {
			return [];
		},
		async info() {
			return { name: "get_project", description: "", inputSchema: {} };
		},
		async exec(server, tool, args) {
			const result = execImpl?.(server, tool, args ?? {});
			if (result === undefined) {
				return {
					isError: false,
					content: [{ type: "text", text: `# Project body\n\nReal content from ${server}/${tool}` }],
				};
			}
			return result as { isError?: boolean; content?: unknown[] };
		},
	};
}

describe("agentFetch logging + onProgress", () => {
	let teardown: (() => void) | null = null;

	afterEach(() => {
		teardown?.();
		teardown = null;
	});

	test("happy path emits info lines for mcp_exec, ok result, and accept", async () => {
		const cap = captureLogs(false);
		teardown = cap.restore;

		const client = fakeClient([
			{
				stop_reason: "tool_use",
				content: [
					{
						type: "tool_use",
						id: "exec-1",
						name: "mcp_exec",
						input: { server: "linear", tool: "get_project", args: { project_id: "abc" } },
					},
				],
			},
			{
				stop_reason: "tool_use",
				content: [
					{
						type: "tool_use",
						id: "accept-1",
						name: "accept_content",
						input: { exec_call_id: "exec-1", mime_type: "text/markdown" },
					},
				],
			},
		]);

		const progress: string[] = [];
		const outcome = await agentFetch({
			url: "https://linear.app/x/project/abc",
			mcpx: makeMcpxStub(),
			llm: baseLlm,
			onProgress: (s) => progress.push(s),
			_testClient: client,
		});

		expect(outcome.kind).toBe("accepted");
		if (outcome.kind === "accepted") {
			expect(outcome.result.fetcherServer).toBe("linear");
			expect(outcome.result.fetcherTool).toBe("get_project");
		}

		// Info lines: tool selection, ok result, accepted, plus turn N>1 line
		const info = cap.logs.info.join("\n");
		expect(info).toContain("turn 1: mcp_exec linear/get_project");
		expect(info).toContain("→ linear/get_project ok (");
		expect(info).toContain("accepted: linear/get_project");
		expect(info).toContain("turn 2/10");

		// onProgress saw activity per turn
		expect(progress.some((s) => s.includes("turn 1"))).toBe(true);
		expect(progress.some((s) => s.includes("mcp_exec linear/get_project"))).toBe(true);
		expect(progress.some((s) => s.includes("accepted linear/get_project"))).toBe(true);

		// debug lines off without verbose
		expect(cap.logs.debug.length).toBe(0);
	});

	test("verbose mode surfaces args and search hits at debug level", async () => {
		const cap = captureLogs(true);
		teardown = cap.restore;

		const client = fakeClient([
			{
				stop_reason: "tool_use",
				content: [
					{
						type: "tool_use",
						id: "search-1",
						name: "mcp_search",
						input: { query: "linear project markdown" },
					},
				],
			},
			{
				stop_reason: "tool_use",
				content: [
					{
						type: "tool_use",
						id: "exec-1",
						name: "mcp_exec",
						input: { server: "linear", tool: "get_project", args: { project_id: "abc" } },
					},
				],
			},
			{
				stop_reason: "tool_use",
				content: [
					{
						type: "tool_use",
						id: "accept-1",
						name: "accept_content",
						input: { exec_call_id: "exec-1" },
					},
				],
			},
		]);

		await agentFetch({
			url: "https://linear.app/x/project/abc",
			mcpx: makeMcpxStub(),
			llm: baseLlm,
			_testClient: client,
		});

		const debug = cap.logs.debug.join("\n");
		expect(debug).toContain('mcp_search "linear project markdown"');
		expect(debug).toContain("mcp_exec args:");
		expect(debug).toContain("project_id");
		// top hits surfaced at debug
		expect(debug).toContain("linear/get_project");
	});

	test("isError result emits error info line; agent can retry", async () => {
		const cap = captureLogs(false);
		teardown = cap.restore;

		const client = fakeClient([
			{
				stop_reason: "tool_use",
				content: [
					{
						type: "tool_use",
						id: "exec-bad",
						name: "mcp_exec",
						input: { server: "linear", tool: "list_comments", args: { project_id: "abc" } },
					},
				],
			},
			{
				stop_reason: "tool_use",
				content: [
					{
						type: "tool_use",
						id: "exec-good",
						name: "mcp_exec",
						input: { server: "linear", tool: "get_project", args: { project_id: "abc" } },
					},
				],
			},
			{
				stop_reason: "tool_use",
				content: [
					{
						type: "tool_use",
						id: "accept-1",
						name: "accept_content",
						input: { exec_call_id: "exec-good" },
					},
				],
			},
		]);

		const mcpx = makeMcpxStub((_server, tool) => {
			if (tool === "list_comments") {
				return { isError: true, content: [{ type: "text", text: "schema mismatch: project_id is not allowed" }] };
			}
			return undefined;
		});

		const outcome = await agentFetch({
			url: "https://linear.app/x/project/abc",
			mcpx,
			llm: baseLlm,
			_testClient: client,
		});

		expect(outcome.kind).toBe("accepted");

		const info = cap.logs.info.join("\n");
		expect(info).toContain("→ linear/list_comments error: schema mismatch");
		expect(info).toContain("→ linear/get_project ok (");
		expect(info).toContain("accepted: linear/get_project");
	});

	test("request_http_fallback emits info line and returns fallback", async () => {
		const cap = captureLogs(false);
		teardown = cap.restore;

		const client = fakeClient([
			{
				stop_reason: "tool_use",
				content: [{ type: "tool_use", id: "fb-1", name: "request_http_fallback", input: {} }],
			},
		]);

		const outcome = await agentFetch({
			url: "https://example.com",
			mcpx: makeMcpxStub(),
			llm: baseLlm,
			_testClient: client,
		});

		expect(outcome.kind).toBe("fallback");
		expect(cap.logs.info.join("\n")).toContain("agent requested HTTP fallback");
	});

	test("missing API key throws auth_error before calling Anthropic", async () => {
		const cap = captureLogs(false);
		teardown = cap.restore;

		try {
			await agentFetch({
				url: "https://example.com",
				mcpx: makeMcpxStub(),
				llm: { ...baseLlm, anthropic_api_key: "" },
			});
			throw new Error("expected agentFetch to throw");
		} catch (err) {
			const e = err as { kind?: string; hint?: string };
			expect(e.kind).toBe("auth_error");
			expect(e.hint ?? "").toContain("ANTHROPIC_API_KEY");
		}
	});
});
