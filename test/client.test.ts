import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MembotClient } from "../src/client.ts";
import { HelpfulError } from "../src/errors.ts";
import { setEmbeddingCacheDir } from "../src/ingest/embedder.ts";

let tmp: string;
let client: MembotClient;

describe("MembotClient", () => {
	beforeAll(() => {
		tmp = realpathSync(mkdtempSync(join(tmpdir(), "membot-client-")));
		setEmbeddingCacheDir(join(tmp, "models"));
		client = new MembotClient({ configFlag: tmp });
	});

	afterAll(async () => {
		await client.close();
		rmSync(tmp, { recursive: true, force: true });
	});

	test("connect() builds the context idempotently and concurrent first-calls share it", async () => {
		const fresh = new MembotClient({ configFlag: tmp });
		const [a, b] = await Promise.all([fresh.connect(), fresh.connect()]);
		expect(a).toBeUndefined();
		expect(b).toBeUndefined();
		await fresh.close();
	});

	test("add → list → read → search → versions round-trip via the client surface", async () => {
		const added = await client.add({
			sources: ["inline:Carbonara is made with eggs, pecorino, and guanciale."],
			logical_path: "recipes/pasta.md",
		});
		expect(added.ok).toBe(1);
		expect(added.failed).toBe(0);

		const listed = await client.list({});
		const paths = listed.entries.map((e) => e.logical_path);
		expect(paths).toContain("recipes/pasta.md");

		const read = await client.read({ logical_path: "recipes/pasta.md" });
		expect(read.content).toContain("Carbonara");
		expect(read.version_is_current).toBe(true);

		const hits = await client.search({ pattern: "Carbonara", mode: "keyword", limit: 5 });
		expect(hits.hits.length).toBeGreaterThan(0);
		expect(hits.hits[0]?.logical_path).toBe("recipes/pasta.md");

		const v = await client.versions({ logical_path: "recipes/pasta.md" });
		expect(v.versions.length).toBe(1);
	}, 120_000);

	test("write creates a new version that supersedes the previous one", async () => {
		const w = await client.write({
			logical_path: "recipes/pasta.md",
			content: "# Pasta (revised)\n\nNew note.",
		});
		expect(w.version_id).toMatch(/T/);
		const v = await client.versions({ logical_path: "recipes/pasta.md" });
		expect(v.versions.length).toBe(2);
		expect(v.versions[0]?.version_id).toBe(w.version_id);
	}, 60_000);

	test("remove tombstones the path; versions still lists it", async () => {
		const r = await client.remove({ paths: ["recipes/pasta.md"] });
		expect(r.ok).toBe(1);

		const listed = await client.list({});
		expect(listed.entries.map((e) => e.logical_path)).not.toContain("recipes/pasta.md");

		const v = await client.versions({ logical_path: "recipes/pasta.md" });
		expect(v.versions.length).toBeGreaterThan(0);
	});

	test("invalid input rejects with HelpfulError(input_error)", async () => {
		try {
			// @ts-expect-error — deliberately wrong shape
			await client.read({});
			throw new Error("expected throw");
		} catch (err) {
			expect(err).toBeInstanceOf(HelpfulError);
			expect((err as HelpfulError).kind).toBe("input_error");
		}
	});

	test("close() is idempotent and method calls after close throw", async () => {
		const fresh = new MembotClient({ configFlag: tmp });
		await fresh.connect();
		await fresh.close();
		await fresh.close();

		try {
			await fresh.list({});
			throw new Error("expected throw");
		} catch (err) {
			expect(err).toBeInstanceOf(HelpfulError);
			expect((err as HelpfulError).message).toMatch(/closed/);
		}
	});
});
