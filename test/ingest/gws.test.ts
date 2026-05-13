import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HelpfulError } from "../../src/errors.ts";
import { gwsExport, resolveGwsBinary } from "../../src/ingest/gws.ts";

/**
 * The Google plugins shell out to `gws`. Real gws calls hit Google and
 * require credentials; we stub the binary with a tiny shell script so
 * we can exercise every exit-code translation deterministically.
 *
 * The stub reads two env vars at invocation time:
 *   STUB_EXIT      — numeric exit code (default 0)
 *   STUB_STDERR    — text to emit on stderr
 *   STUB_OUT_BYTES — bytes to write to the file passed via `-o`
 */
const SUPPORTS_SHEBANG = process.platform !== "win32";

describe.if(SUPPORTS_SHEBANG)("gws wrapper", () => {
	let work: string;
	let savedGwsPath: string | undefined;

	beforeEach(() => {
		work = mkdtempSync(join(tmpdir(), "membot-gws-test-"));
		savedGwsPath = process.env.MEMBOT_GWS_PATH;
	});

	afterEach(() => {
		if (savedGwsPath === undefined) delete process.env.MEMBOT_GWS_PATH;
		else process.env.MEMBOT_GWS_PATH = savedGwsPath;
		rmSync(work, { recursive: true, force: true });
	});

	function installStub(behavior: { exit: number; stderr?: string; outBytes?: string }): string {
		const stub = join(work, "gws");
		// Inline each behavior directly into the script body — no env-var
		// inheritance to debug across the JS→shell boundary, and each test
		// gets its own clean script.
		const outBytesFile = behavior.outBytes ? join(work, "stub-out-bytes") : "";
		if (behavior.outBytes !== undefined) writeFileSync(outBytesFile, behavior.outBytes);
		const stderrFile = behavior.stderr ? join(work, "stub-stderr") : "";
		if (behavior.stderr !== undefined) writeFileSync(stderrFile, behavior.stderr);

		const lines = ["#!/bin/sh", 'OUT=""'];
		lines.push('while [ $# -gt 0 ]; do');
		lines.push('  if [ "$1" = "-o" ]; then OUT="$2"; shift 2; else shift; fi');
		lines.push("done");
		if (outBytesFile) {
			lines.push(`if [ -n "$OUT" ]; then cat "${outBytesFile}" > "$OUT"; fi`);
		}
		if (stderrFile) {
			lines.push(`cat "${stderrFile}" >&2`);
		}
		lines.push(`exit ${behavior.exit}`);

		writeFileSync(stub, lines.join("\n") + "\n");
		chmodSync(stub, 0o755);
		process.env.MEMBOT_GWS_PATH = stub;
		return stub;
	}

	test("resolveGwsBinary honors MEMBOT_GWS_PATH", () => {
		const stub = installStub({ exit: 0, outBytes: "hi" });
		expect(resolveGwsBinary()).toBe(stub);
	});

	test("resolveGwsBinary returns null when no binary is reachable", () => {
		process.env.MEMBOT_GWS_PATH = "/nonexistent/path/gws";
		expect(resolveGwsBinary()).toBeNull();
	});

	test("gwsExport returns bytes on exit 0", async () => {
		installStub({ exit: 0, outBytes: "PK\x03\x04docx-bytes" });
		const bytes = await gwsExport({
			fileId: "abc",
			mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		});
		expect(new TextDecoder().decode(bytes)).toBe("PK\x03\x04docx-bytes");
	});

	test("exit 2 → auth_error with `membot login` hint", async () => {
		installStub({ exit: 2, stderr: "No credentials found. Run `gws auth setup` ..." });
		try {
			await gwsExport({ fileId: "abc", mimeType: "application/pdf" });
			throw new Error("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(HelpfulError);
			const e = err as HelpfulError;
			expect(e.kind).toBe("auth_error");
			expect(e.hint).toContain("membot login");
		}
	});

	test("exit 1 with accessNotConfigured → auth_error pointing at Drive-API enablement", async () => {
		installStub({
			exit: 1,
			stderr: "Error: accessNotConfigured: Drive API has not been used in project 12345 or it is disabled.",
		});
		try {
			await gwsExport({ fileId: "abc", mimeType: "application/pdf" });
			throw new Error("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(HelpfulError);
			const e = err as HelpfulError;
			expect(e.kind).toBe("auth_error");
			expect(e.hint).toContain("Drive API");
		}
	});

	test("exit 1 with `exceeds the maximum` → network_error pointing at the 10 MB cap", async () => {
		installStub({ exit: 1, stderr: "Error: This file exceeds the maximum export size of 10 MB." });
		try {
			await gwsExport({ fileId: "abc", mimeType: "application/pdf" });
			throw new Error("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(HelpfulError);
			const e = err as HelpfulError;
			expect(e.kind).toBe("network_error");
			expect(e.message).toContain("10 MB");
			expect(e.hint).toContain("membot add");
		}
	});

	test("unknown non-zero exit → generic network_error with stderr surfaced", async () => {
		installStub({ exit: 5, stderr: "kaboom" });
		try {
			await gwsExport({ fileId: "abc", mimeType: "application/pdf" });
			throw new Error("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(HelpfulError);
			const e = err as HelpfulError;
			expect(e.kind).toBe("network_error");
			expect(e.message).toContain("kaboom");
			expect(e.hint).toContain("gws drive files export");
		}
	});

	test("gwsExport throws when MEMBOT_GWS_PATH points nowhere", async () => {
		process.env.MEMBOT_GWS_PATH = "/nope/gws";
		try {
			await gwsExport({ fileId: "abc", mimeType: "application/pdf" });
			throw new Error("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(HelpfulError);
			const e = err as HelpfulError;
			expect(e.kind).toBe("internal_error");
			expect(e.hint).toContain("Reinstall membot");
		}
	});
});
