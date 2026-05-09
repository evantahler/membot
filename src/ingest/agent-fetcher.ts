import Anthropic from "@anthropic-ai/sdk";
import type {
	Tool as AnthropicTool,
	MessageParam,
	ToolResultBlockParam,
	ToolUseBlock,
} from "@anthropic-ai/sdk/resources/messages";
import type { LlmConfig } from "../config/schemas.ts";
import { HelpfulError } from "../errors.ts";
import { logger } from "../output/logger.ts";
import { sha256Hex } from "./local-reader.ts";

/** Number of times the agent may iterate. Each turn = one Claude call + tool dispatch. */
const MAX_TURNS = 10;
/** Bytes of content shown back to the LLM in the mcp_exec preview. The harness has the full content. */
const PREVIEW_CHARS = 2_000;
/** Token budget per Claude call. Should comfortably fit a tool-use response + reasoning. */
const MAX_RESPONSE_TOKENS = 4_096;

/**
 * Outcome shape mirrored from `FetchedRemote` in fetcher.ts. We don't
 * import that type here to avoid a cycle — the fetcher imports us.
 */
export interface AgentFetchedRemote {
	bytes: Uint8Array;
	sha256: string;
	mimeType: string;
	fetcher: "mcpx";
	fetcherServer: string;
	fetcherTool: string;
	fetcherArgs: Record<string, unknown>;
	sourceUrl: string;
}

/**
 * The slice of mcpx the agent loop needs. Kept minimal so tests can
 * stub it without spinning up a real client.
 */
export interface AgentMcpxAdapter {
	search(
		query: string,
		options?: { keywordOnly?: boolean; semanticOnly?: boolean },
	): Promise<{ server: string; tool: string; description?: string; score?: number; matchType?: string }[]>;
	listTools(server?: string): Promise<{ server: string; tool: { name: string; description?: string } }[]>;
	info(
		server: string,
		tool: string,
	): Promise<{ name: string; description?: string; inputSchema?: unknown } | undefined>;
	exec(
		server: string,
		tool: string,
		args?: Record<string, unknown>,
	): Promise<{ isError?: boolean; content?: unknown[] }>;
}

export interface AgentFetchOptions {
	url: string;
	mcpx: AgentMcpxAdapter;
	llm: LlmConfig;
	hint?: string;
	/** Test seam: inject a pre-built Anthropic client. */
	_testClient?: Anthropic;
}

/**
 * Outcome of the agent loop:
 *   - `accepted`: the agent picked a captured mcp_exec result; caller stores it as the new version.
 *   - `fallback`: the agent gave up on mcpx (request_http_fallback, no tool calls, max turns); caller does plain HTTP.
 *   - HelpfulError thrown: the agent reported an actionable failure (report_failure), or the loop hit a hard error.
 */
export type AgentFetchOutcome = { kind: "accepted"; result: AgentFetchedRemote } | { kind: "fallback"; reason: string };

const FETCHER_SYSTEM_PROMPT = `You are a content fetcher. Your job is to find the right MCP tool to retrieve the content at the given URL, run it, and tell the harness which result to save.

**Important: the harness captures the full result of every mcp_exec call automatically.** You only see a short preview of each result so you can verify it looks reasonable. You do NOT need to read or copy the full content — you just identify which exec call to save.

**Format preference: markdown, in order of preference.**
1. When searching with mcp_search or mcp_list_tools, prefer tools whose names indicate markdown output: anything containing "markdown", "md", "AsMarkdown", "AsMd", "AsDocmd", or similar.
2. If no markdown-named variant exists, use mcp_info to inspect the tool's input schema for a "format", "mime_type", "output_format", or similar parameter and request "markdown" (or "md") when available.
3. If neither is possible, run the tool anyway. The membot pipeline will normalize the captured content downstream — markdown-native tools are still preferred because they're cheaper and higher fidelity, but you do not have to find one.

Workflow:
1. Use mcp_search or mcp_list_tools to find the best tool for this URL (e.g., Google Docs tools for docs.google.com, Firecrawl for generic web pages, GitHub tools for github.com). Apply the format preference above.
2. Use mcp_info to inspect the tool's input schema. **Required before mcp_exec on any tool you haven't called this session.** Many tools want \`document_id\`, \`repo\`, \`page_id\`, etc. — not \`url\`. Extract the right value from the URL.
3. Call mcp_exec with arguments that conform to the schema.
4. **Multi-step workflows are expected.** Many providers need a sequence of calls — e.g. Firecrawl: \`scrape\` returns a job id, then \`get_job_status\` polls until done, then the final result has the content; some doc providers need a \`prepare/export\` call before \`download\`; large docs may paginate. Make as many mcp_exec calls as needed. Read each preview to decide the next step.
5. If the tool errors (input_error / auth_error / "still processing"), read the error, adjust, and retry — or pivot to a different tool.
6. Once a successful exec preview looks like the FINAL content, call accept_content with the exec_call_id (the tool_use_id of that mcp_exec call) and the actual mime_type the tool returned. Pick the call whose result is the actual content — not an intermediate job id or status response.

Terminal tools (call exactly one):
- accept_content(exec_call_id, mime_type?) — save the content captured from a previous mcp_exec call.
- request_http_fallback() — fall back to a basic HTTP fetch. Use only when no MCP tool can handle the URL after a genuine attempt.
- report_failure(message) — surface an actionable message to the user (e.g., "this Google Doc is private — share it with your service account"). Use only when there is a specific next step the user must take.`;

const acceptContentTool: AnthropicTool = {
	name: "accept_content",
	description:
		"Save the full content captured by the harness from a previous mcp_exec call. You only need to supply the exec_call_id (the tool_use_id of that mcp_exec call). The harness already has the full content. Do NOT paste content here.",
	input_schema: {
		type: "object" as const,
		properties: {
			exec_call_id: {
				type: "string",
				description:
					"The tool_use_id of the mcp_exec call whose result should be saved (the harness lists captured ids in mcp_exec previews).",
			},
			mime_type: {
				type: "string",
				description:
					"MIME type the source tool returned (e.g. 'text/markdown', 'text/html', 'application/json'). Defaults to text/markdown.",
			},
		},
		required: ["exec_call_id"],
	},
};

const requestHttpFallbackTool: AnthropicTool = {
	name: "request_http_fallback",
	description: "Fall back to a basic HTTP fetch. Use only when no MCP tool can handle the URL after a genuine attempt.",
	input_schema: { type: "object" as const, properties: {}, required: [] },
};

const reportFailureTool: AnthropicTool = {
	name: "report_failure",
	description:
		"Report a fetch failure with an actionable message for the user (e.g., 'this Google Doc is private — share it with your service account'). Use only when there is a clear next step the user must take.",
	input_schema: {
		type: "object" as const,
		properties: {
			message: {
				type: "string",
				description: "Clear, actionable, user-facing message explaining what the user needs to do.",
			},
		},
		required: ["message"],
	},
};

const mcpSearchTool: AnthropicTool = {
	name: "mcp_search",
	description:
		"Search for MCP tools by keyword + semantic similarity over the live mcpx catalog. Returns up to a handful of {server, tool, description, score} entries.",
	input_schema: {
		type: "object" as const,
		properties: {
			query: { type: "string", description: "Search query (e.g. 'fetch google docs as markdown')." },
		},
		required: ["query"],
	},
};

const mcpListToolsTool: AnthropicTool = {
	name: "mcp_list_tools",
	description: "List available tools from configured MCP servers. Optionally filter by server name.",
	input_schema: {
		type: "object" as const,
		properties: {
			server: { type: "string", description: "Optional server name to filter on." },
		},
		required: [],
	},
};

const mcpInfoTool: AnthropicTool = {
	name: "mcp_info",
	description:
		"Get the full schema (name, description, input parameters) for a specific MCP tool. Required before mcp_exec on tools you haven't called this session.",
	input_schema: {
		type: "object" as const,
		properties: {
			server: { type: "string", description: "MCP server name." },
			tool: { type: "string", description: "Tool name on the server." },
		},
		required: ["server", "tool"],
	},
};

const mcpExecTool: AnthropicTool = {
	name: "mcp_exec",
	description:
		"Execute a tool on an MCP server. The full result is captured by the harness keyed by tool_use_id; you receive a short preview to verify the content. To save the result, call accept_content with the exec_call_id.",
	input_schema: {
		type: "object" as const,
		properties: {
			server: { type: "string", description: "MCP server name." },
			tool: { type: "string", description: "Tool name on the server." },
			args: {
				type: "object",
				description: "Arguments object that conforms to the tool's input schema (verify via mcp_info).",
			},
		},
		required: ["server", "tool"],
	},
};

const ALL_TOOLS: AnthropicTool[] = [
	mcpSearchTool,
	mcpListToolsTool,
	mcpInfoTool,
	mcpExecTool,
	acceptContentTool,
	requestHttpFallbackTool,
	reportFailureTool,
];

interface CapturedExec {
	server: string;
	tool: string;
	args: Record<string, unknown>;
	content: string;
	mimeType: string;
}

/**
 * Run the multi-turn fetcher agent. Mirrors botholomew's `runFetcherLoop`.
 *
 * Returns `{ kind: "accepted", result }` when the agent calls `accept_content`
 * on a captured mcp_exec result. Returns `{ kind: "fallback" }` when the agent
 * calls `request_http_fallback`, produces no tool calls, or exhausts MAX_TURNS.
 * Throws `HelpfulError` when the agent calls `report_failure` (the actionable
 * message becomes the error's `message`/`hint`).
 */
export async function agentFetch(opts: AgentFetchOptions): Promise<AgentFetchOutcome> {
	if (!opts.llm.anthropic_api_key || opts.llm.anthropic_api_key.trim() === "") {
		throw new HelpfulError({
			kind: "auth_error",
			message: `agentFetch requires ANTHROPIC_API_KEY but llm.anthropic_api_key is empty.`,
			hint: `Set ANTHROPIC_API_KEY in your environment or under llm.anthropic_api_key in ~/.membot/config.json.`,
		});
	}

	const client = opts._testClient ?? new Anthropic({ apiKey: opts.llm.anthropic_api_key });

	const userPrompt = opts.hint
		? `Fetch the content at: ${opts.url}\n\nAdditional guidance:\n${opts.hint}`
		: `Fetch the content at: ${opts.url}`;
	const messages: MessageParam[] = [{ role: "user", content: userPrompt }];

	const captured = new Map<string, CapturedExec>();

	for (let turn = 0; turn < MAX_TURNS; turn++) {
		const response = await client.messages.create({
			model: opts.llm.converter_model,
			max_tokens: MAX_RESPONSE_TOKENS,
			system: FETCHER_SYSTEM_PROMPT,
			messages,
			tools: ALL_TOOLS,
		});

		for (const block of response.content) {
			if (block.type === "text" && block.text.trim()) {
				logger.debug(`agent-fetch turn ${turn + 1}: ${block.text.trim()}`);
			}
		}

		if (response.stop_reason === "max_tokens") {
			throw new HelpfulError({
				kind: "internal_error",
				message: `Fetcher agent hit max_tokens (${MAX_RESPONSE_TOKENS}) on turn ${turn + 1}.`,
				hint: `The fetched document or the agent's reasoning is too long. Try \`membot add ${opts.url} --fetcher http\` or fetch a more specific section.`,
			});
		}

		const toolUseBlocks = response.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
		if (toolUseBlocks.length === 0) {
			logger.debug(`agent-fetch turn ${turn + 1}: no tool calls — falling back to HTTP`);
			return { kind: "fallback", reason: "agent stopped without selecting an outcome" };
		}

		messages.push({ role: "assistant", content: response.content });

		// Terminal tools — checked in priority order.
		const failureCall = toolUseBlocks.find((b) => b.name === "report_failure");
		if (failureCall) {
			const input = failureCall.input as Partial<{ message: string }>;
			const message =
				typeof input.message === "string" && input.message.trim()
					? input.message.trim()
					: "Fetch failed but the agent did not provide a message.";
			throw new HelpfulError({
				kind: "input_error",
				message: `Fetcher agent reported failure for ${opts.url}: ${message}`,
				hint: message,
			});
		}

		const fallbackCall = toolUseBlocks.find((b) => b.name === "request_http_fallback");
		if (fallbackCall) {
			logger.debug(`agent-fetch turn ${turn + 1}: agent requested HTTP fallback`);
			return { kind: "fallback", reason: "agent requested HTTP fallback" };
		}

		const acceptCall = toolUseBlocks.find((b) => b.name === "accept_content");
		if (acceptCall) {
			const input = acceptCall.input as Partial<{ exec_call_id: string; mime_type: string }>;
			if (typeof input.exec_call_id !== "string") {
				messages.push({
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: acceptCall.id,
							content: "Invalid accept_content call: 'exec_call_id' is required.",
							is_error: true,
						},
					],
				});
				continue;
			}
			const cached = captured.get(input.exec_call_id);
			if (!cached) {
				const validIds = [...captured.keys()];
				messages.push({
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: acceptCall.id,
							content: `No mcp_exec call with id "${input.exec_call_id}" was captured. Captured ids: ${validIds.length ? validIds.join(", ") : "(none yet — run mcp_exec first)"}.`,
							is_error: true,
						},
					],
				});
				continue;
			}
			const claimedMime = (input.mime_type ?? cached.mimeType ?? "text/markdown").trim() || "text/markdown";
			const bytes = new TextEncoder().encode(cached.content);
			return {
				kind: "accepted",
				result: {
					bytes,
					sha256: sha256Hex(bytes),
					mimeType: claimedMime,
					fetcher: "mcpx",
					fetcherServer: cached.server,
					fetcherTool: cached.tool,
					fetcherArgs: cached.args,
					sourceUrl: opts.url,
				},
			};
		}

		// Discovery / exec tools — execute in parallel, feed results back.
		const toolResults: ToolResultBlockParam[] = await Promise.all(
			toolUseBlocks.map((toolUse) => dispatchAgentTool(toolUse, opts.mcpx, captured)),
		);
		messages.push({ role: "user", content: toolResults });
	}

	logger.debug(`agent-fetch: max turns (${MAX_TURNS}) exceeded — falling back to HTTP`);
	return { kind: "fallback", reason: `agent exceeded MAX_TURNS=${MAX_TURNS}` };
}

/** Execute one agent tool call and produce the tool_result block fed back to Claude. */
async function dispatchAgentTool(
	toolUse: ToolUseBlock,
	mcpx: AgentMcpxAdapter,
	captured: Map<string, CapturedExec>,
): Promise<ToolResultBlockParam> {
	try {
		switch (toolUse.name) {
			case "mcp_search":
				return await runMcpSearch(toolUse, mcpx);
			case "mcp_list_tools":
				return await runMcpListTools(toolUse, mcpx);
			case "mcp_info":
				return await runMcpInfo(toolUse, mcpx);
			case "mcp_exec":
				return await runMcpExec(toolUse, mcpx, captured);
			default:
				return {
					type: "tool_result",
					tool_use_id: toolUse.id,
					content: `Unknown tool: ${toolUse.name}`,
					is_error: true,
				};
		}
	} catch (err) {
		return {
			type: "tool_result",
			tool_use_id: toolUse.id,
			content: `Error: ${err instanceof Error ? err.message : String(err)}`,
			is_error: true,
		};
	}
}

async function runMcpSearch(toolUse: ToolUseBlock, mcpx: AgentMcpxAdapter): Promise<ToolResultBlockParam> {
	const input = toolUse.input as Partial<{ query: string }>;
	if (typeof input.query !== "string" || !input.query.trim()) {
		return { type: "tool_result", tool_use_id: toolUse.id, content: "mcp_search requires 'query'.", is_error: true };
	}
	try {
		const results = await mcpx.search(input.query);
		return {
			type: "tool_result",
			tool_use_id: toolUse.id,
			content: JSON.stringify(
				{
					results: results.slice(0, 10).map((r) => ({
						server: r.server,
						tool: r.tool,
						description: r.description ?? "",
						score: r.score ?? 0,
					})),
					hint:
						results.length > 0
							? "Use mcp_info to read the input schema before mcp_exec."
							: "No results. Try broader terms or mcp_list_tools.",
				},
				null,
				2,
			),
		};
	} catch (err) {
		return {
			type: "tool_result",
			tool_use_id: toolUse.id,
			content: `mcp_search failed: ${err instanceof Error ? err.message : String(err)}. Try mcp_list_tools instead.`,
			is_error: true,
		};
	}
}

async function runMcpListTools(toolUse: ToolUseBlock, mcpx: AgentMcpxAdapter): Promise<ToolResultBlockParam> {
	const input = toolUse.input as Partial<{ server: string }>;
	const tools = await mcpx.listTools(input.server);
	const mapped = tools.map((t) => ({ server: t.server, name: t.tool.name, description: t.tool.description ?? "" }));
	return {
		type: "tool_result",
		tool_use_id: toolUse.id,
		content: JSON.stringify(
			{
				tools: mapped,
				hint:
					mapped.length > 0
						? "Use mcp_info on a {server, name} pair before mcp_exec."
						: "No tools. mcpx may not be configured.",
			},
			null,
			2,
		),
	};
}

async function runMcpInfo(toolUse: ToolUseBlock, mcpx: AgentMcpxAdapter): Promise<ToolResultBlockParam> {
	const input = toolUse.input as Partial<{ server: string; tool: string }>;
	if (typeof input.server !== "string" || typeof input.tool !== "string") {
		return {
			type: "tool_result",
			tool_use_id: toolUse.id,
			content: "mcp_info requires 'server' and 'tool'.",
			is_error: true,
		};
	}
	const tool = await mcpx.info(input.server, input.tool);
	if (!tool) {
		return {
			type: "tool_result",
			tool_use_id: toolUse.id,
			content: `Tool "${input.tool}" not found on server "${input.server}". Use mcp_search or mcp_list_tools.`,
			is_error: true,
		};
	}
	return {
		type: "tool_result",
		tool_use_id: toolUse.id,
		content: JSON.stringify(
			{
				name: tool.name,
				description: tool.description ?? "",
				input_schema: tool.inputSchema ?? {},
				hint: `Call mcp_exec with server='${input.server}', tool='${tool.name}', and args matching this schema.`,
			},
			null,
			2,
		),
	};
}

async function runMcpExec(
	toolUse: ToolUseBlock,
	mcpx: AgentMcpxAdapter,
	captured: Map<string, CapturedExec>,
): Promise<ToolResultBlockParam> {
	const input = toolUse.input as Partial<{ server: string; tool: string; args: Record<string, unknown> }>;
	if (typeof input.server !== "string" || typeof input.tool !== "string") {
		return {
			type: "tool_result",
			tool_use_id: toolUse.id,
			content: "mcp_exec requires 'server' and 'tool'.",
			is_error: true,
		};
	}
	const args = (input.args ?? {}) as Record<string, unknown>;

	let result: { isError?: boolean; content?: unknown[] };
	try {
		result = await mcpx.exec(input.server, input.tool, args);
	} catch (err) {
		return {
			type: "tool_result",
			tool_use_id: toolUse.id,
			content: `mcp_exec ${input.server}/${input.tool} threw: ${err instanceof Error ? err.message : String(err)}. Use mcp_info to verify the schema, then retry — or pivot to a different tool.`,
			is_error: true,
		};
	}

	const text = extractText(result);

	if (result.isError === true) {
		return {
			type: "tool_result",
			tool_use_id: toolUse.id,
			content: `mcp_exec ${input.server}/${input.tool} returned isError=true: ${text}\n\nUse mcp_info to check the schema, fix the args, and retry — or try a different tool.`,
			is_error: true,
		};
	}

	if (!text?.trim()) {
		return {
			type: "tool_result",
			tool_use_id: toolUse.id,
			content: `mcp_exec ${input.server}/${input.tool} returned empty content. Try a different tool or different args.`,
			is_error: true,
		};
	}

	captured.set(toolUse.id, { server: input.server, tool: input.tool, args, content: text, mimeType: "text/markdown" });
	const preview =
		text.length > PREVIEW_CHARS
			? `${text.slice(0, PREVIEW_CHARS)}\n\n[... ${text.length - PREVIEW_CHARS} more chars truncated. Full content (${text.length} chars total) is captured by the harness with exec_call_id="${toolUse.id}". Call accept_content with this id to save it.]`
			: `${text}\n\n[Full content (${text.length} chars) captured by the harness with exec_call_id="${toolUse.id}". Call accept_content with this id to save it.]`;
	return { type: "tool_result", tool_use_id: toolUse.id, content: preview };
}

/**
 * Extract a single string out of an MCP CallToolResult envelope. Mirrors
 * the heterogeneous shapes mcpx tools return; tolerates string content,
 * `text` fields, and the array-of-content-blocks shape.
 */
function extractText(result: { content?: unknown } | unknown): string {
	if (typeof result === "string") return result;
	if (!result || typeof result !== "object") return "";
	const r = result as Record<string, unknown>;
	if (typeof r.text === "string") return r.text;
	if (typeof r.content === "string") return r.content;
	if (typeof r.markdown === "string") return r.markdown;
	if (Array.isArray(r.content)) {
		const out: string[] = [];
		for (const c of r.content) {
			if (c && typeof c === "object") {
				const inner = c as Record<string, unknown>;
				if (typeof inner.text === "string") out.push(inner.text);
			}
		}
		if (out.length > 0) return out.join("\n\n");
	}
	try {
		return JSON.stringify(result);
	} catch {
		return "";
	}
}
