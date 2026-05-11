import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { type AppContext, buildContext, closeContext } from "../context.ts";
import { mountAsMcpTool } from "../mount/mcp.ts";
import { OPERATIONS } from "../operations/index.ts";
import { logger } from "../output/logger.ts";
import { SERVER_INSTRUCTIONS } from "./instructions.ts";

export interface McpServerOptions {
	configFlag?: string;
	httpPort?: number;
}

/**
 * Build a fresh `McpServer` instance with every Operation mounted as a
 * tool. The supplied `ctxFactory` is awaited lazily on the first tool
 * invocation — for stdio servers we share one context across the connection;
 * for HTTP servers we'd want one context per session, but for now a single
 * lazy-initialized context is fine.
 */
export function buildMcpServer(ctxFactory: () => Promise<AppContext>): McpServer {
	const server = new McpServer({ name: "membot", version: "0.0.1" }, { instructions: SERVER_INSTRUCTIONS });

	let ctxPromise: Promise<AppContext> | null = null;
	const getCtx = async () => {
		if (!ctxPromise) ctxPromise = ctxFactory();
		return ctxPromise;
	};

	for (const op of OPERATIONS) {
		mountAsMcpTool(server, op, getCtx);
	}

	return server;
}

/**
 * Start the MCP server in stdio mode. Used by `membot serve` (default
 * transport) so MCP clients (mcpx, Claude Desktop, etc.) can connect over
 * stdin/stdout.
 */
export async function startStdioServer(options: McpServerOptions = {}): Promise<() => Promise<void>> {
	let ctx: AppContext | null = null;
	const server = buildMcpServer(async () => {
		ctx = await buildContext({ configFlag: options.configFlag, json: true });
		return ctx;
	});
	const transport = new StdioServerTransport();
	await server.connect(transport);
	logger.info("membot-mcp: stdio server connected");
	return async () => {
		await server.close();
		if (ctx) await closeContext(ctx);
	};
}

/**
 * Start the MCP server in HTTP (streamable) mode. Used by
 * `membot serve --http <port>` to expose the same tools over HTTP for
 * browser-based or remote clients.
 */
export async function startHttpServer(port: number, options: McpServerOptions = {}): Promise<() => Promise<void>> {
	let ctx: AppContext | null = null;
	const server = buildMcpServer(async () => {
		ctx = await buildContext({ configFlag: options.configFlag, json: true });
		return ctx;
	});
	const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID() });
	await server.connect(transport);

	const httpServer = Bun.serve({
		port,
		async fetch(req) {
			const url = new URL(req.url);
			if (url.pathname !== "/mcp") return new Response("not found", { status: 404 });
			const body = await req.arrayBuffer();
			const headers: Record<string, string> = {};
			req.headers.forEach((v, k) => {
				headers[k] = v;
			});
			// Adapt Bun's Request → Node-shaped req/res. Streamable HTTP
			// transport expects a Node IncomingMessage / ServerResponse;
			// for now the SDK provides handlers for Web's Request directly
			// in newer versions. Simplest: forward to transport.handleRequest.
			const resp = await transport.handleRequest(
				req as unknown as Parameters<typeof transport.handleRequest>[0],
				undefined as unknown as Parameters<typeof transport.handleRequest>[1],
				body,
			);
			return resp as unknown as Response;
		},
	});

	logger.info(`membot-mcp: http listening on :${port}/mcp`);
	return async () => {
		httpServer.stop();
		await server.close();
		if (ctx) await closeContext(ctx);
	};
}
