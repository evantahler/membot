import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import type { AppContext } from "../context.ts";
import { asHelpful, HelpfulError, isHelpfulError } from "../errors.ts";
import { composeDescription, type Operation } from "../operations/types.ts";

/**
 * Mount an Operation as an MCP tool on the supplied server. The tool:
 *   1. registers using `op.name` and `op.description`
 *   2. exposes the zod input schema as JSON-Schema (via the SDK helper)
 *   3. validates input + output through the same zod schemas the CLI uses
 *   4. catches HelpfulError and returns it as `isError: true` with the
 *      hint placed in BOTH the rendered text and `structuredContent.error`
 */
export function mountAsMcpTool<I extends z.ZodObject, O extends z.ZodTypeAny>(
	server: McpServer,
	op: Operation<I, O>,
	getCtx: () => Promise<AppContext>,
): void {
	server.registerTool(
		op.name,
		{
			description: composeDescription(op),
			inputSchema: op.inputSchema.shape as unknown as Record<string, z.ZodTypeAny>,
		},
		async (rawInput: unknown): Promise<CallToolResult> => {
			let parsedInput: z.infer<I>;
			try {
				parsedInput = parseInput(op, rawInput);
			} catch (err) {
				return renderMcpError(err);
			}

			let ctx: AppContext;
			try {
				ctx = await getCtx();
			} catch (err) {
				return renderMcpError(err);
			}

			try {
				const result = await op.handler(parsedInput, ctx);
				const validated = parseOutput(op, result);
				return {
					content: [{ type: "text", text: jsonOrText(validated) }],
					structuredContent: validated as Record<string, unknown>,
				};
			} catch (err) {
				return renderMcpError(err);
			} finally {
				// Drop the DuckDB lock between MCP tool calls so concurrent CLI
				// or daemon callers can claim it. The next tool call reopens.
				try {
					await ctx.db.release();
				} catch {
					// best effort — never let release failures mask a tool result
				}
			}
		},
	);
}

/** Validate the MCP-supplied input against the operation's zod schema. */
function parseInput<I extends z.ZodObject, O extends z.ZodTypeAny>(op: Operation<I, O>, raw: unknown): z.infer<I> {
	const result = op.inputSchema.safeParse(raw);
	if (!result.success) {
		throw new HelpfulError({
			kind: "input_error",
			message: `invalid input to ${op.name}: ${result.error.message}`,
			hint: `Check the tool's inputSchema. Common issues: missing required fields, wrong types, unknown fields.`,
			details: result.error.issues,
		});
	}
	return result.data;
}

/** Validate the handler's return value against the operation's output schema. */
function parseOutput<I extends z.ZodObject, O extends z.ZodTypeAny>(op: Operation<I, O>, result: unknown): z.infer<O> {
	const validated = op.outputSchema.safeParse(result);
	if (!validated.success) {
		throw new HelpfulError({
			kind: "internal_error",
			message: `${op.name} produced output that doesn't match its declared schema: ${validated.error.message}`,
			hint: "This is a membot bug. Report at https://github.com/evantahler/membot/issues.",
			details: validated.error.issues,
		});
	}
	return validated.data;
}

/**
 * Render any thrown value as an MCP `isError: true` result. The hint lands
 * in both the human-visible text content and the `structuredContent.error`
 * field so an LLM consuming the tool result gets identical guidance.
 */
export function renderMcpError(err: unknown): CallToolResult {
	const helpful = isHelpfulError(err)
		? err
		: asHelpful(err, "unexpected error", "This is a membot bug; check server logs.", "internal_error");
	return {
		isError: true,
		content: [{ type: "text", text: `${helpful.message}\n\nhint: ${helpful.hint}` }],
		structuredContent: {
			error: {
				kind: helpful.kind,
				message: helpful.message,
				hint: helpful.hint,
				details: helpful.details ?? null,
			},
		},
	};
}

/** Serialize an output value to a single text block — JSON for objects, raw for strings. */
function jsonOrText(value: unknown): string {
	if (typeof value === "string") return value;
	return JSON.stringify(value, null, 2);
}
