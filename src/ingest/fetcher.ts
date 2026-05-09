import type { LlmConfig } from "../config/schemas.ts";
import { DEFAULTS } from "../constants.ts";
import { asHelpful, HelpfulError } from "../errors.ts";
import { logger } from "../output/logger.ts";
import type { AgentMcpxAdapter } from "./agent-fetcher.ts";
import { agentFetch } from "./agent-fetcher.ts";
import { sha256Hex } from "./local-reader.ts";

export interface FetchedRemote {
	bytes: Uint8Array;
	sha256: string;
	mimeType: string;
	fetcher: "http" | "mcpx";
	fetcherServer: string | null;
	fetcherTool: string | null;
	fetcherArgs: Record<string, unknown> | null;
	sourceUrl: string;
}

export interface FetchOptions {
	/**
	 * User-provided hint. Free-form keyword (e.g. "firecrawl", "github",
	 * "google-docs", "http"). Special-cased: "http" forces plain fetch.
	 * Otherwise the hint is passed verbatim to the agent loop as extra
	 * guidance about which provider to prefer.
	 */
	hint?: string;
	/** Live mcpx adapter the agent loop drives via search/list/info/exec. */
	mcpx?: AgentMcpxAdapter | null;
	/**
	 * LLM config. The agent loop needs an Anthropic key; without one the
	 * mcpx path is skipped and we fall back to plain HTTP.
	 */
	llm?: LlmConfig;
	/**
	 * Forwarded to the agent loop so callers (e.g. the ingest progress
	 * reporter) can drive a spinner sublabel from per-turn agent activity.
	 */
	onProgress?: (sublabel: string) => void;
}

/**
 * Fetch a remote URL.
 *
 * - `--fetcher http` (or no mcpx, or no LLM key) → plain HTTP.
 * - Otherwise → multi-turn agent loop: Claude is given mcpx tools
 *   (search/list/info/exec) and decides how to retrieve the URL,
 *   including multi-step flows (start a job → poll → download).
 *   The agent's selected mcp_exec invocation is recorded on the
 *   returned row so refresh can replay it deterministically without
 *   another agent round-trip.
 *
 * If the agent decides plain HTTP is the right call (`request_http_fallback`,
 * no tool calls, max turns) we transparently fall through to `httpFetch`.
 * If the agent reports an actionable failure, we surface that as a
 * `HelpfulError`. If mcpx is configured but the LLM key is missing AND
 * the HTTP fallback also fails, we surface an `auth_error` naming the env
 * var so users see the real cause instead of a misleading 401.
 */
export async function fetchRemote(url: string, options: FetchOptions = {}): Promise<FetchedRemote> {
	const mcpx = options.mcpx;
	const hint = options.hint?.trim();

	if (hint === "http") return httpFetch(url);
	if (!mcpx) return httpFetch(url);

	const apiKey = options.llm?.anthropic_api_key?.trim();
	if (!apiKey) {
		// No way to drive the agent. Try HTTP; if that fails, the user
		// almost certainly wanted mcpx — surface a clear key-missing error.
		try {
			return await httpFetch(url);
		} catch (err) {
			if (err instanceof HelpfulError && err.kind === "network_error") {
				throw new HelpfulError({
					kind: "auth_error",
					message: `${url} couldn't be fetched directly (${err.message}). Membot has mcpx configured, but routing through it requires Claude to translate the URL into the right tool arguments — and ANTHROPIC_API_KEY isn't set.`,
					hint: `Set ANTHROPIC_API_KEY in your environment (or under llm.anthropic_api_key in ~/.membot/config.json), then retry. To force the HTTP path explicitly, run \`membot add ${url} --fetcher http\`.`,
				});
			}
			throw err;
		}
	}

	let outcome: Awaited<ReturnType<typeof agentFetch>>;
	try {
		outcome = await agentFetch({ url, mcpx, llm: options.llm!, hint, onProgress: options.onProgress });
	} catch (err) {
		if (err instanceof HelpfulError) throw err;
		logger.warn(`agent-fetch failed (${err instanceof Error ? err.message : String(err)}) — falling back to HTTP`);
		return httpFetch(url);
	}

	if (outcome.kind === "accepted") {
		return {
			bytes: outcome.result.bytes,
			sha256: outcome.result.sha256,
			mimeType: outcome.result.mimeType,
			fetcher: "mcpx",
			fetcherServer: outcome.result.fetcherServer,
			fetcherTool: outcome.result.fetcherTool,
			fetcherArgs: outcome.result.fetcherArgs,
			sourceUrl: url,
		};
	}
	logger.info(`[fetcher] falling back to HTTP: ${outcome.reason}`);
	return httpFetch(url);
}

/** Plain `fetch` fallback. Used when mcpx isn't configured or the hint says so. */
async function httpFetch(url: string): Promise<FetchedRemote> {
	let resp: Response;
	try {
		resp = await fetch(url, {
			headers: { "User-Agent": "membot/0.1" },
			signal: AbortSignal.timeout(DEFAULTS.HTTP_TIMEOUT_MS),
		});
	} catch (err) {
		throw asHelpful(
			err,
			`while fetching ${url}`,
			`Check your network and that ${url} is reachable. For mcpx-managed sources (gdocs/github/firecrawl), set ANTHROPIC_API_KEY so membot can drive an mcpx tool.`,
			"network_error",
		);
	}
	if (!resp.ok) {
		throw new HelpfulError({
			kind: "network_error",
			message: `HTTP ${resp.status} ${resp.statusText}: ${url}`,
			hint: "Verify the URL is reachable and not gated behind auth. For private docs use mcpx (set ANTHROPIC_API_KEY).",
		});
	}
	const bytes = new Uint8Array(await resp.arrayBuffer());
	const ct = resp.headers.get("content-type") ?? "";
	const mime = ct.split(";")[0]?.trim() || "application/octet-stream";
	return {
		bytes,
		sha256: sha256Hex(bytes),
		mimeType: mime,
		fetcher: "http",
		fetcherServer: null,
		fetcherTool: null,
		fetcherArgs: null,
		sourceUrl: url,
	};
}

/**
 * Detect MCP `CallToolResult` envelopes that signal tool failure. MCP
 * tool errors don't throw — they return `{ isError: true, content: [...] }`
 * — so callers must check this explicitly before treating the content
 * as a successful payload. Used by the refresh runner; the agent loop
 * has its own preview-aware check.
 */
export function isMcpToolError(result: unknown): boolean {
	if (!result || typeof result !== "object") return false;
	return (result as { isError?: unknown }).isError === true;
}
