import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");

interface RunResult {
	stdout: string;
	stderr: string;
	exit: number;
}

async function runCli(args: string[], home: string): Promise<RunResult> {
	const proc = Bun.spawn(["bun", CLI, ...args], {
		env: { ...process.env, NO_COLOR: "1", MEMBOT_HOME: home },
		stdout: "pipe",
		stderr: "pipe",
	});
	const exit = await proc.exited;
	return {
		stdout: await new Response(proc.stdout).text(),
		stderr: await new Response(proc.stderr).text(),
		exit,
	};
}

function makeLogFile(home: string, lines: string[]): string {
	const dir = join(home, "logs");
	mkdirSync(dir, { recursive: true });
	const path = join(dir, "serve.log");
	writeFileSync(path, `${lines.join("\n")}\n`);
	return path;
}

describe("membot logs", () => {
	let root: string;

	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "membot-logs-cmd-"));
	});

	afterAll(() => {
		rmSync(root, { recursive: true, force: true });
	});

	test("--raw prints the last N raw JSON lines verbatim", async () => {
		const home = mkdtempSync(join(root, "json-"));
		const records = [];
		for (let i = 0; i < 20; i++) {
			records.push(JSON.stringify({ ts: "2026-05-10T00:00:00Z", level: "info", msg: `m${i}` }));
		}
		makeLogFile(home, records);

		const r = await runCli(["logs", "--raw", "--lines", "5"], home);
		expect(r.exit).toBe(0);
		const out = r.stdout.trim().split("\n");
		expect(out).toHaveLength(5);
		expect(out[0]).toBe(records[15]);
		expect(out[4]).toBe(records[19]);
	});

	test("pretty output includes ts, level, event tag, and msg", async () => {
		const home = mkdtempSync(join(root, "pretty-"));
		const records = [
			JSON.stringify({
				ts: "2026-05-10T01:02:03Z",
				level: "info",
				msg: "tool call",
				event: "mcp.call.ok",
				tool: "membot_search",
				duration_ms: 42,
			}),
		];
		makeLogFile(home, records);

		const r = await runCli(["logs", "--lines", "1"], home);
		expect(r.exit).toBe(0);
		expect(r.stdout).toContain("2026-05-10T01:02:03Z");
		expect(r.stdout).toContain("info");
		expect(r.stdout).toContain("[mcp.call.ok membot_search]");
		expect(r.stdout).toContain("tool call");
	});

	test("returns not_found exit code when no log file exists", async () => {
		const home = mkdtempSync(join(root, "missing-"));
		const r = await runCli(["logs"], home);
		expect(r.exit).toBe(3);
		expect(r.stderr).toContain("no log file at");
		expect(r.stderr).toContain("membot serve");
	});
});
