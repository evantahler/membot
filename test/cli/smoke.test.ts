import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");

let tmp: string;
let dataDir: string;
let docPath: string;

/** Run `membot` with the given args against an isolated data dir. Returns stdout + exit. */
async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; exit: number }> {
	const proc = Bun.spawn(["bun", CLI, ...args, "--json"], {
		env: { ...process.env, MEMBOT_HOME: dataDir, NO_COLOR: "1" },
		stdout: "pipe",
		stderr: "pipe",
	});
	const exit = await proc.exited;
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	return { stdout, stderr, exit };
}

describe("CLI smoke (spawns the real binary entrypoint)", () => {
	beforeAll(() => {
		tmp = mkdtempSync(join(tmpdir(), "membot-cli-"));
		dataDir = join(tmp, "data");
		docPath = join(tmp, "smoke.md");
		writeFileSync(docPath, "# Smoke Test\n\nThis is a smoke test for the membot CLI ingest path.\n");
	});

	afterAll(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	test("--help exits cleanly and lists every operation as a subcommand", async () => {
		const r = await runCli(["--help"]);
		expect(r.exit).toBe(0);
		// commander's --help goes to stdout
		const helpText = r.stdout || r.stderr;
		for (const cmd of [
			"add",
			"ls",
			"tree",
			"read",
			"search",
			"info",
			"versions",
			"diff",
			"write",
			"mv",
			"rm",
			"refresh",
			"prune",
		]) {
			expect(helpText).toContain(cmd);
		}
	});

	test("add → ls → search → read round-trips a real file end-to-end", async () => {
		const add = await runCli(["add", docPath]);
		expect(add.exit).toBe(0);
		const addParsed = JSON.parse(add.stdout) as {
			ingested: { logical_path: string; status: string; size_bytes: number }[];
			ok: number;
			failed: number;
		};
		expect(addParsed.ok).toBe(1);
		expect(addParsed.failed).toBe(0);
		expect(addParsed.ingested[0]?.status).toBe("ok");

		const ls = await runCli(["ls"]);
		expect(ls.exit).toBe(0);
		const lsParsed = JSON.parse(ls.stdout) as { entries: { logical_path: string }[] };
		expect(lsParsed.entries.length).toBe(1);
		const logical = lsParsed.entries[0]!.logical_path;

		const search = await runCli(["search", "smoke test"]);
		expect(search.exit).toBe(0);
		const searchParsed = JSON.parse(search.stdout) as { hits: { logical_path: string }[] };
		expect(searchParsed.hits[0]?.logical_path).toBe(logical);

		const read = await runCli(["read", logical]);
		expect(read.exit).toBe(0);
		const readParsed = JSON.parse(read.stdout) as { content: string };
		expect(readParsed.content).toContain("Smoke Test");
	}, 180_000);

	test("missing path produces a HelpfulError JSON to stdout with non-zero exit", async () => {
		const r = await runCli(["read", "does/not/exist.md"]);
		expect(r.exit).not.toBe(0);
		// In --json mode all machine-readable output (success AND error) goes to
		// stdout; stderr is reserved for unstructured noise (bun startup chatter,
		// embedder warmup, dotenv warnings, etc.) and is not parsed here.
		const parsed = JSON.parse(r.stdout) as {
			ok: false;
			error: { kind: string; hint: string; message: string };
		};
		expect(parsed.ok).toBe(false);
		expect(parsed.error.kind).toBe("not_found");
		expect(parsed.error.hint.length).toBeGreaterThan(0);
	});
});
