import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MembotConfigSchema } from "../../src/config/schemas.ts";
import { fetchRemote } from "../../src/ingest/fetcher.ts";

const baseLlm = MembotConfigSchema.parse({}).llm;

describe("fetchRemote (coordinator)", () => {
	let server: ReturnType<typeof Bun.serve>;
	let baseUrl: string;

	beforeAll(() => {
		server = Bun.serve({
			port: 0,
			fetch(req) {
				const url = new URL(req.url);
				if (url.pathname === "/ok") {
					return new Response("hello world", { headers: { "content-type": "text/plain" } });
				}
				if (url.pathname === "/md") {
					return new Response("# title\n\nbody", { headers: { "content-type": "text/markdown" } });
				}
				if (url.pathname === "/401") {
					return new Response("nope", { status: 401 });
				}
				return new Response("?", { status: 500 });
			},
		});
		baseUrl = `http://${server.hostname}:${server.port}`;
	});

	afterAll(() => {
		server.stop();
	});

	test("hint=http forces plain HTTP", async () => {
		const r = await fetchRemote(`${baseUrl}/ok`, { hint: "http" });
		expect(new TextDecoder().decode(r.bytes)).toBe("hello world");
		expect(r.fetcher).toBe("http");
	});

	test("no mcpx adapter → HTTP fetch (no agent involved)", async () => {
		const r = await fetchRemote(`${baseUrl}/md`, {});
		expect(r.mimeType).toBe("text/markdown");
		expect(r.fetcher).toBe("http");
	});

	test("non-2xx HTTP response → HelpfulError(network_error)", async () => {
		expect(fetchRemote(`${baseUrl}/401`, { hint: "http" })).rejects.toMatchObject({ kind: "network_error" });
	});

	test("mcpx configured but no API key → tries HTTP first; HTTP works → success", async () => {
		const stub = makeUnusedMcpxStub();
		const r = await fetchRemote(`${baseUrl}/ok`, { mcpx: stub, llm: { ...baseLlm, anthropic_api_key: "" } });
		expect(r.fetcher).toBe("http");
		expect(stub.callCounts.search).toBe(0);
		expect(stub.callCounts.exec).toBe(0);
	});

	test("mcpx configured but no API key + HTTP fails → HelpfulError(auth_error) naming the env var", async () => {
		const stub = makeUnusedMcpxStub();
		try {
			await fetchRemote(`${baseUrl}/401`, { mcpx: stub, llm: { ...baseLlm, anthropic_api_key: "" } });
			throw new Error("expected fetchRemote to throw");
		} catch (err) {
			const e = err as { kind?: string; hint?: string; message?: string };
			expect(e.kind).toBe("auth_error");
			expect(e.hint ?? "").toContain("ANTHROPIC_API_KEY");
		}
	});
});

/** Stub mcpx adapter that records call counts but never returns useful data. */
function makeUnusedMcpxStub() {
	const callCounts = { search: 0, listTools: 0, info: 0, exec: 0 };
	return {
		callCounts,
		async search() {
			callCounts.search++;
			return [];
		},
		async listTools() {
			callCounts.listTools++;
			return [];
		},
		async info() {
			callCounts.info++;
			return undefined;
		},
		async exec() {
			callCounts.exec++;
			return {};
		},
	};
}
