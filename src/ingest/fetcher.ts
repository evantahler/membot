import { DEFAULTS } from "../constants.ts";
import { asHelpful, HelpfulError } from "../errors.ts";
import { logger } from "../output/logger.ts";
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

export interface McpxToolDescriptor {
	server: string;
	tool: { name: string; description?: string };
}

export interface McpxSearchHit {
	server: string;
	tool: { name: string; description?: string };
	score?: number;
}

export interface FetchOptions {
	/**
	 * User-provided hint. Free-form keyword (e.g. "firecrawl", "github",
	 * "google-docs", "http"). Special-cased: "http" forces plain fetch.
	 * Otherwise the hint is used as a search query against the live
	 * mcpx tool catalog — we never hardcode server names.
	 */
	hint?: string;
	/** Live mcpx adapter. Use listTools/search/exec to find a fetcher on the fly. */
	mcpx?: {
		exec(server: string, tool: string, args: Record<string, unknown>): Promise<unknown>;
		listTools(): Promise<McpxToolDescriptor[]>;
		search?(query: string): Promise<McpxSearchHit[]>;
	} | null;
}

/**
 * Fetch a remote URL, preferring an mcpx-managed server (Firecrawl, Google
 * Docs, GitHub, …) for known providers and falling back to a plain `fetch`
 * otherwise. The chosen invocation (server/tool/args) is returned alongside
 * the bytes so the caller can persist it on the row for replay-on-refresh.
 */
export async function fetchRemote(url: string, options: FetchOptions = {}): Promise<FetchedRemote> {
	const mcpx = options.mcpx;
	const hint = options.hint?.trim();

	if (hint === "http") return httpFetch(url);
	if (!mcpx) return httpFetch(url);

	const tried = await tryMcpx(url, mcpx, hint);
	if (tried) return tried;
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
			`Check your network and that ${url} is reachable. For mcpx-managed sources (gdocs/github/firecrawl), set --fetcher firecrawl etc.`,
			"network_error",
		);
	}
	if (!resp.ok) {
		throw new HelpfulError({
			kind: "network_error",
			message: `HTTP ${resp.status} ${resp.statusText}: ${url}`,
			hint: "Verify the URL is reachable and not gated behind auth. For private docs use mcpx via --fetcher.",
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
 * Attempt to fetch via mcpx by discovering a suitable tool at runtime.
 *
 * Strategy:
 *   1. If the user passed a hint, search for it via mcpx.search() (semantic
 *      tool search over the live catalog). The hint is the user's free-text
 *      label for which provider they want — we never assume server names.
 *   2. Otherwise, fall back to a host-based search query (e.g. URL host
 *      "github.com" → search for "github fetch markdown").
 *   3. From the returned candidates, prefer tools whose name or description
 *      signals markdown output. Failing that, the first tool that takes a
 *      URL-shaped argument.
 *   4. Execute the tool with `{ url, format: "markdown" }`-shaped args.
 *      If exec fails, return null so the caller falls back to plain HTTP.
 */
async function tryMcpx(
	url: string,
	mcpx: NonNullable<FetchOptions["mcpx"]>,
	hint: string | undefined,
): Promise<FetchedRemote | null> {
	const candidates = await discoverCandidates(url, mcpx, hint);
	if (candidates.length === 0) return null;

	const chosen = pickTool(candidates);
	if (!chosen) return null;

	const args = buildArgs(chosen.tool.name, url);
	let result: unknown;
	try {
		result = await mcpx.exec(chosen.server, chosen.tool.name, args);
	} catch (err) {
		logger.warn(
			`mcpx: ${chosen.server}/${chosen.tool.name} failed (${err instanceof Error ? err.message : String(err)})`,
		);
		return null;
	}

	const text = extractText(result);
	if (!text || text.trim().length === 0) return null;
	const bytes = new TextEncoder().encode(text);
	return {
		bytes,
		sha256: sha256Hex(bytes),
		mimeType: "text/markdown",
		fetcher: "mcpx",
		fetcherServer: chosen.server,
		fetcherTool: chosen.tool.name,
		fetcherArgs: args,
		sourceUrl: url,
	};
}

/**
 * Build a list of candidate fetcher tools by querying mcpx's live catalog.
 * Tries semantic search first (using the hint or the URL's host as the
 * query) then falls back to listing all tools and filtering by name. Never
 * hardcodes a server name — the catalog is the source of truth.
 */
async function discoverCandidates(
	url: string,
	mcpx: NonNullable<FetchOptions["mcpx"]>,
	hint: string | undefined,
): Promise<McpxToolDescriptor[]> {
	const host = safeHost(url);
	const queries = buildQueries(hint, host);

	if (mcpx.search) {
		for (const q of queries) {
			try {
				const hits = await mcpx.search(q);
				if (hits.length > 0) {
					return hits.slice(0, 5).map((h) => ({ server: h.server, tool: h.tool }));
				}
			} catch (err) {
				logger.debug(`mcpx: search(${q}) failed (${err instanceof Error ? err.message : String(err)})`);
			}
		}
	}

	let tools: McpxToolDescriptor[];
	try {
		tools = await mcpx.listTools();
	} catch (err) {
		logger.debug(`mcpx: listTools failed (${err instanceof Error ? err.message : String(err)})`);
		return [];
	}

	const lowercaseHaystack = (t: McpxToolDescriptor) =>
		`${t.server} ${t.tool.name} ${t.tool.description ?? ""}`.toLowerCase();

	if (hint) {
		const needle = hint.toLowerCase();
		const matched = tools.filter((t) => lowercaseHaystack(t).includes(needle));
		if (matched.length > 0) return matched;
	}

	if (host) {
		const tokens = host.split(".");
		const matched = tools.filter((t) => tokens.some((tok) => tok.length > 2 && lowercaseHaystack(t).includes(tok)));
		if (matched.length > 0) return matched;
	}

	// Fall back to any tool that looks like a URL fetcher.
	return tools.filter((t) => /fetch|scrape|http|url/i.test(`${t.tool.name} ${t.tool.description ?? ""}`));
}

/** Compose semantic-search queries to feed mcpx.search. */
function buildQueries(hint: string | undefined, host: string | null): string[] {
	const out: string[] = [];
	if (hint) out.push(`${hint} fetch markdown`);
	if (host) out.push(`fetch ${host} as markdown`, `scrape ${host}`);
	out.push("fetch URL as markdown", "scrape webpage to markdown");
	return out;
}

/** URL → hostname or null. */
function safeHost(url: string): string | null {
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return null;
	}
}

/**
 * Among the candidate tools, prefer one whose name or description signals
 * markdown output (contains "markdown", "md", "Docmd", etc.). Falls back
 * to anything that looks like a generic fetch/scrape verb, and finally
 * to the first candidate so we always try something.
 */
function pickTool(tools: McpxToolDescriptor[]): McpxToolDescriptor | null {
	const score = (t: McpxToolDescriptor) => {
		const hay = `${t.tool.name} ${t.tool.description ?? ""}`.toLowerCase();
		let s = 0;
		if (/markdown|docmd|asmd|\bmd\b/.test(hay)) s += 5;
		if (/scrape|extract|fetch|get|read/.test(hay)) s += 2;
		if (/url|web|html|page/.test(hay)) s += 1;
		return s;
	};
	const sorted = [...tools].sort((a, b) => score(b) - score(a));
	return sorted[0] ?? null;
}

/**
 * Build the argument object the mcpx fetcher tool likely accepts. We can't
 * know the schema without calling info(), so we build a permissive bag with
 * the common shapes (`{url, format: "markdown", formats: ["markdown"]}`)
 * and trust the underlying tool to ignore unknown fields.
 */
function buildArgs(toolName: string, url: string): Record<string, unknown> {
	const args: Record<string, unknown> = { url };
	if (/markdown|md/i.test(toolName)) args.format = "markdown";
	args.formats = ["markdown"];
	return args;
}

/** Pull a string out of the heterogeneous shapes mcpx tools return. */
function extractText(result: unknown): string {
	if (typeof result === "string") return result;
	if (result && typeof result === "object") {
		const maybe = result as Record<string, unknown>;
		if (typeof maybe.text === "string") return maybe.text;
		if (typeof maybe.content === "string") return maybe.content;
		if (typeof maybe.markdown === "string") return maybe.markdown;
		if (Array.isArray(maybe.content)) {
			const out: string[] = [];
			for (const c of maybe.content) {
				if (c && typeof c === "object") {
					const inner = c as Record<string, unknown>;
					if (typeof inner.text === "string") out.push(inner.text);
				}
			}
			if (out.length > 0) return out.join("\n\n");
		}
	}
	try {
		return JSON.stringify(result);
	} catch {
		return "";
	}
}
