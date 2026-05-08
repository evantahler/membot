import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");

let root: string;

interface RunResult {
	stdout: string;
	stderr: string;
	exit: number;
}

async function runCli(args: string[], cwd: string, env: Record<string, string> = {}): Promise<RunResult> {
	const proc = Bun.spawn(["bun", CLI, ...args], {
		cwd,
		env: { ...process.env, NO_COLOR: "1", ...env },
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

describe("skill install", () => {
	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "membot-skill-"));
	});

	afterAll(() => {
		rmSync(root, { recursive: true, force: true });
	});

	test("--claude --project writes .claude/skills/membot.md with the expected frontmatter", async () => {
		const cwd = mkdtempSync(join(root, "claude-project-"));
		const r = await runCli(["skill", "install", "--claude", "--project"], cwd);
		expect(r.exit).toBe(0);

		const dest = join(cwd, ".claude", "skills", "membot.md");
		expect(existsSync(dest)).toBe(true);
		const body = readFileSync(dest, "utf-8");
		expect(body.startsWith("---\n")).toBe(true);
		expect(body).toContain("name: membot");
	});

	test("--cursor --global writes ~/.cursor/rules/membot.mdc using HOME override", async () => {
		const cwd = mkdtempSync(join(root, "cursor-global-"));
		const fakeHome = mkdtempSync(join(root, "home-"));
		const r = await runCli(["skill", "install", "--cursor", "--global"], cwd, { HOME: fakeHome });
		expect(r.exit).toBe(0);

		const dest = join(fakeHome, ".cursor", "rules", "membot.mdc");
		expect(existsSync(dest)).toBe(true);
		const body = readFileSync(dest, "utf-8");
		expect(body).toContain("alwaysApply: true");
	});

	test("--claude --cursor installs both files in one invocation", async () => {
		const cwd = mkdtempSync(join(root, "both-"));
		const r = await runCli(["skill", "install", "--claude", "--cursor", "--project"], cwd);
		expect(r.exit).toBe(0);
		expect(existsSync(join(cwd, ".claude", "skills", "membot.md"))).toBe(true);
		expect(existsSync(join(cwd, ".cursor", "rules", "membot.mdc"))).toBe(true);
	});

	test("existing file without --force errors with a HelpfulError JSON in --json mode", async () => {
		const cwd = mkdtempSync(join(root, "conflict-"));
		const dest = join(cwd, ".claude", "skills", "membot.md");
		Bun.spawnSync(["mkdir", "-p", join(cwd, ".claude", "skills")]);
		writeFileSync(dest, "pre-existing");

		const r = await runCli(["--json", "skill", "install", "--claude", "--project"], cwd);
		expect(r.exit).not.toBe(0);
		const parsed = JSON.parse(r.stderr) as {
			ok: false;
			error: { kind: string; hint: string; message: string };
		};
		expect(parsed.ok).toBe(false);
		expect(parsed.error.kind).toBe("conflict");
		expect(parsed.error.hint).toContain("--force");
		expect(readFileSync(dest, "utf-8")).toBe("pre-existing");
	});

	test("--force overwrites an existing file", async () => {
		const cwd = mkdtempSync(join(root, "force-"));
		Bun.spawnSync(["mkdir", "-p", join(cwd, ".claude", "skills")]);
		const dest = join(cwd, ".claude", "skills", "membot.md");
		writeFileSync(dest, "stale content");

		const r = await runCli(["skill", "install", "--claude", "--project", "--force"], cwd);
		expect(r.exit).toBe(0);
		expect(readFileSync(dest, "utf-8")).toContain("name: membot");
	});

	test("missing --claude/--cursor errors with a HelpfulError naming the missing flags", async () => {
		const cwd = mkdtempSync(join(root, "no-target-"));
		const r = await runCli(["--json", "skill", "install"], cwd);
		expect(r.exit).not.toBe(0);
		const parsed = JSON.parse(r.stderr) as {
			ok: false;
			error: { kind: string; hint: string };
		};
		expect(parsed.error.kind).toBe("input_error");
		expect(parsed.error.hint).toContain("--claude");
		expect(parsed.error.hint).toContain("--cursor");
	});
});
