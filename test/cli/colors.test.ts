import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");

// MEMBOT_HOME is isolated per test, but the model cache lives under it
// (`<home>/models`); redirect it to a shared persistent cache so spawned CLIs
// reuse the downloaded weights instead of re-fetching on every run.
const MODEL_CACHE = process.env.MEMBOT_MODEL_CACHE_DIR ?? join(homedir(), ".membot", "models");

let tmp: string;
let dataDir: string;
let docPath: string;

/**
 * Spawn the real CLI binary with `FORCE_COLOR=1` so ansis emits ANSI sequences
 * even though the parent test process has `NO_COLOR=1` set in the preload.
 * This lets us assert end-to-end that colours land on the wire when expected.
 */
async function run(
	args: string[],
	extraEnv: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; exit: number }> {
	const env: Record<string, string> = { ...process.env, MEMBOT_HOME: dataDir, MEMBOT_MODEL_CACHE_DIR: MODEL_CACHE };
	env.FORCE_COLOR = "1";
	delete env.NO_COLOR;
	for (const [k, v] of Object.entries(extraEnv)) env[k] = v;

	const proc = Bun.spawn(["bun", CLI, ...args], { env, stdout: "pipe", stderr: "pipe" });
	const exit = await proc.exited;
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	return { stdout, stderr, exit };
}

describe("CLI ANSI emission (real spawn, FORCE_COLOR=1)", () => {
	beforeAll(async () => {
		tmp = mkdtempSync(join(tmpdir(), "membot-color-"));
		dataDir = join(tmp, "data");
		docPath = join(tmp, "doc.md");
		writeFileSync(docPath, "# Colors test\n\nA short markdown file used to populate the store.\n");

		const env: Record<string, string> = {
			...process.env,
			MEMBOT_HOME: dataDir,
			MEMBOT_MODEL_CACHE_DIR: MODEL_CACHE,
			NO_COLOR: "1",
		};
		const seed = Bun.spawn(["bun", CLI, "add", docPath, "--json"], { env, stdout: "pipe", stderr: "pipe" });
		await seed.exited;
	}, 180_000);

	afterAll(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	test("ls emits ANSI escape bytes on stdout when FORCE_COLOR=1", async () => {
		const r = await run(["ls"]);
		expect(r.exit).toBe(0);
		expect(r.stdout).toContain("\x1b[");
	});

	test("ls suppresses ANSI when --no-color is passed (overrides FORCE_COLOR)", async () => {
		const r = await run(["--no-color", "ls"]);
		expect(r.exit).toBe(0);
		expect(r.stdout).not.toContain("\x1b[");
	});

	test("ls --json emits no ANSI on stdout regardless of FORCE_COLOR", async () => {
		const r = await run(["--json", "ls"]);
		expect(r.exit).toBe(0);
		expect(r.stdout).not.toContain("\x1b[");
		// Ensure stdout is parseable JSON.
		const parsed = JSON.parse(r.stdout);
		expect(parsed).toHaveProperty("entries");
	});

	test("error path emits red/yellow ANSI sequences on stderr", async () => {
		const r = await run(["read", "does/not/exist.md"]);
		expect(r.exit).not.toBe(0);
		expect(r.stderr).toContain("\x1b[31m"); // red message
		expect(r.stderr).toContain("\x1b[33m"); // yellow hint:
		expect(r.stderr).toContain("✗");
		expect(r.stderr).toContain("hint:");
	});

	test("error path under --json emits clean JSON to stdout (no ANSI)", async () => {
		const r = await run(["--json", "read", "does/not/exist.md"]);
		expect(r.exit).not.toBe(0);
		expect(r.stdout).not.toContain("\x1b[");
		const parsed = JSON.parse(r.stdout);
		expect(parsed.ok).toBe(false);
		expect(parsed.error.kind).toBe("not_found");
	});
});
