import { afterEach, describe, expect, test } from "bun:test";
import { HelpfulError } from "../../src/errors.ts";
import { renderCliError } from "../../src/mount/commander.ts";
import { detectMode, setMode } from "../../src/output/tty.ts";

/** Capture process.stderr writes during fn(); return concatenated string. */
function captureStderr(fn: () => void): string {
	const buf: string[] = [];
	const orig = process.stderr.write.bind(process.stderr);
	// biome-ignore lint/suspicious/noExplicitAny: minimal override for test capture
	(process.stderr as any).write = (chunk: string | Uint8Array): boolean => {
		buf.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
		return true;
	};
	try {
		fn();
	} finally {
		// biome-ignore lint/suspicious/noExplicitAny: restore
		(process.stderr as any).write = orig;
	}
	return buf.join("");
}

describe("renderCliError", () => {
	afterEach(() => {
		setMode(detectMode({}));
	});

	test("renders cross, message, hint label, hint, and details on stderr", () => {
		setMode(detectMode({}));
		const err = new HelpfulError({
			kind: "not_found",
			message: "no version of foo/bar",
			hint: "Run `membot ls` to see paths.",
			details: { path: "foo/bar" },
		});
		const out = captureStderr(() => renderCliError(err));
		expect(out).toContain("✗ no version of foo/bar");
		expect(out).toContain("hint: Run `membot ls` to see paths.");
		expect(out).toContain('details: {"path":"foo/bar"}');
	});

	test("with NO_COLOR forced, emits no escape bytes anywhere", () => {
		setMode(detectMode({ noColor: true }));
		const err = new HelpfulError({
			kind: "not_found",
			message: "missing",
			hint: "Try membot ls.",
		});
		const out = captureStderr(() => renderCliError(err));
		expect(out).not.toContain("\x1b[");
		expect(out).toContain("✗ missing");
		expect(out).toContain("hint: Try membot ls.");
	});

	test("emits structured JSON to stderr in --json mode (no ANSI, no human framing)", () => {
		setMode(detectMode({ json: true }));
		const err = new HelpfulError({
			kind: "input_error",
			message: "bad input",
			hint: "Pass --help.",
		});
		const out = captureStderr(() => renderCliError(err));
		expect(out).not.toContain("\x1b[");
		const parsed = JSON.parse(out.trim());
		expect(parsed.ok).toBe(false);
		expect(parsed.error).toMatchObject({
			kind: "input_error",
			message: "bad input",
			hint: "Pass --help.",
		});
	});

	test("wraps non-HelpfulError throws via asHelpful", () => {
		setMode(detectMode({ noColor: true }));
		const out = captureStderr(() => renderCliError(new Error("boom")));
		expect(out).toContain("✗ unexpected error");
		expect(out).toContain("hint: Re-run with --verbose");
	});
});
