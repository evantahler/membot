import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { AppContext } from "../../src/context.ts";
import { HelpfulError } from "../../src/errors.ts";
import { mountAsMcpTool } from "../../src/mount/mcp.ts";
import { defineOperation } from "../../src/operations/types.ts";
import { logger } from "../../src/output/logger.ts";
import { getMode, type OutputMode, setMode } from "../../src/output/tty.ts";

type ToolHandler = (rawInput: unknown) => Promise<CallToolResult>;

interface StubServer {
	registerTool: (
		name: string,
		config: { description: string; inputSchema: z.ZodRawShape },
		handler: ToolHandler,
	) => void;
	calls: Map<string, ToolHandler>;
}

function makeStubServer(): StubServer {
	const calls = new Map<string, ToolHandler>();
	return {
		calls,
		registerTool: (name, _config, handler) => {
			calls.set(name, handler);
		},
	};
}

interface ParsedLine {
	level?: string;
	msg?: string;
	event?: string;
	tool?: string;
	call_id?: string;
	arg_keys?: string[];
	duration_ms?: number;
	result_bytes?: number;
	error_kind?: string;
	error_hint?: string;
	[k: string]: unknown;
}

function readLines(path: string): ParsedLine[] {
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((l) => l.length > 0)
		.map((l) => JSON.parse(l) as ParsedLine);
}

function fakeCtx(): AppContext {
	return {
		db: {
			release: async () => {},
		},
	} as unknown as AppContext;
}

describe("mountAsMcpTool audit logging", () => {
	let prevMode: OutputMode;
	let dir: string;
	let logPath: string;

	beforeEach(() => {
		prevMode = getMode();
		dir = mkdtempSync(join(tmpdir(), "membot-mcp-log-"));
		logPath = join(dir, "serve.log");
		setMode({ interactive: false, color: false, json: true, verbose: false, silent: false });
		logger.attachFileSink(logPath);
	});

	afterEach(() => {
		logger.detachFileSink();
		setMode(prevMode);
	});

	test("logs start + ok for a successful call with arg_keys and result_bytes", async () => {
		const op = defineOperation({
			name: "membot_test_ok",
			description: "test",
			inputSchema: z.object({ q: z.string(), limit: z.number().default(5) }),
			outputSchema: z.object({ count: z.number() }),
			handler: async () => ({ count: 1 }),
		});
		const server = makeStubServer();
		mountAsMcpTool(server as unknown as Parameters<typeof mountAsMcpTool>[0], op, async () => fakeCtx());
		const handler = server.calls.get("membot_test_ok");
		expect(handler).toBeDefined();
		const result = await handler?.({ q: "hello", limit: 3 });
		expect(result?.isError).toBeUndefined();
		logger.detachFileSink();

		const lines = readLines(logPath);
		const start = lines.find((l) => l.event === "mcp.call.start");
		const ok = lines.find((l) => l.event === "mcp.call.ok");
		expect(start).toBeDefined();
		expect(ok).toBeDefined();
		expect(start?.tool).toBe("membot_test_ok");
		expect(start?.arg_keys?.sort()).toEqual(["limit", "q"]);
		expect(start?.call_id).toBe(ok?.call_id);
		expect(typeof ok?.duration_ms).toBe("number");
		expect(typeof ok?.result_bytes).toBe("number");
		// We never log the actual argument values or result body.
		const serialized = JSON.stringify(lines);
		expect(serialized).not.toContain("hello");
		expect(serialized).not.toContain('"count":1');
	});

	test("logs start + err for a HelpfulError thrown by the handler", async () => {
		const op = defineOperation({
			name: "membot_test_err",
			description: "test",
			inputSchema: z.object({ x: z.string() }),
			outputSchema: z.object({}),
			handler: async () => {
				throw new HelpfulError({
					kind: "not_found",
					message: "no such thing",
					hint: "Try again with a real path.",
				});
			},
		});
		const server = makeStubServer();
		mountAsMcpTool(server as unknown as Parameters<typeof mountAsMcpTool>[0], op, async () => fakeCtx());
		const handler = server.calls.get("membot_test_err");
		const result = await handler?.({ x: "nope" });
		expect(result?.isError).toBe(true);
		logger.detachFileSink();

		const lines = readLines(logPath);
		const start = lines.find((l) => l.event === "mcp.call.start");
		const err = lines.find((l) => l.event === "mcp.call.err");
		expect(start).toBeDefined();
		expect(err).toBeDefined();
		expect(err?.error_kind).toBe("not_found");
		expect(err?.error_hint).toBe("Try again with a real path.");
		expect(err?.call_id).toBe(start?.call_id);
	});
});
