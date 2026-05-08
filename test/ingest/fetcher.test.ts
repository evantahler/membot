import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { fetchRemote } from "../../src/ingest/fetcher.ts";

describe("fetchRemote", () => {
	let server: ReturnType<typeof Bun.serve>;
	let baseUrl: string;

	beforeAll(() => {
		server = Bun.serve({
			port: 0,
			fetch(req) {
				const url = new URL(req.url);
				if (url.pathname === "/ok") {
					return new Response("hello world", {
						headers: { "content-type": "text/plain" },
					});
				}
				if (url.pathname === "/md") {
					return new Response("# title\n\nbody", {
						headers: { "content-type": "text/markdown" },
					});
				}
				if (url.pathname === "/404") {
					return new Response("nope", { status: 404 });
				}
				return new Response("?", { status: 500 });
			},
		});
		baseUrl = `http://${server.hostname}:${server.port}`;
	});

	afterAll(() => {
		server.stop();
	});

	test("plain http fetch returns bytes + sha + mime", async () => {
		const r = await fetchRemote(`${baseUrl}/ok`, { hint: "http" });
		expect(new TextDecoder().decode(r.bytes)).toBe("hello world");
		expect(r.mimeType).toBe("text/plain");
		expect(r.fetcher).toBe("http");
		expect(r.sha256).toMatch(/^[a-f0-9]{64}$/);
		expect(r.fetcherServer).toBeNull();
	});

	test("markdown content-type round-trips", async () => {
		const r = await fetchRemote(`${baseUrl}/md`, { hint: "http" });
		expect(r.mimeType).toBe("text/markdown");
	});

	test("non-2xx becomes a HelpfulError(network_error)", async () => {
		expect(fetchRemote(`${baseUrl}/404`, { hint: "http" })).rejects.toMatchObject({ kind: "network_error" });
	});

	test("mcpx adapter is consulted before HTTP fallback", async () => {
		const calls: { server: string; tool: string; args: Record<string, unknown> }[] = [];
		const r = await fetchRemote("https://docs.google.com/a/b", {
			hint: "google docs",
			mcpx: {
				async listTools() {
					return [
						{ server: "google-docs", tool: { name: "GetDocAsMarkdown", description: "fetch as markdown" } },
						{ server: "other", tool: { name: "Boring" } },
					];
				},
				async search(_q: string) {
					return [
						{ server: "google-docs", tool: { name: "GetDocAsMarkdown", description: "fetch as markdown" }, score: 1 },
					];
				},
				async exec(server, tool, args) {
					calls.push({ server, tool, args });
					return { content: "# title\n\nbody" };
				},
			},
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]?.server).toBe("google-docs");
		expect(calls[0]?.tool).toBe("GetDocAsMarkdown");
		expect(calls[0]?.args.url).toBe("https://docs.google.com/a/b");
		expect(r.fetcher).toBe("mcpx");
		expect(r.fetcherServer).toBe("google-docs");
		expect(r.fetcherTool).toBe("GetDocAsMarkdown");
	});

	test("mcpx exec failure falls back to HTTP", async () => {
		const r = await fetchRemote(`${baseUrl}/ok`, {
			hint: "broken",
			mcpx: {
				async listTools() {
					return [{ server: "broken", tool: { name: "Scrape" } }];
				},
				async exec() {
					throw new Error("rate limit");
				},
			},
		});
		expect(r.fetcher).toBe("http");
		expect(new TextDecoder().decode(r.bytes)).toBe("hello world");
	});
});
