import { afterEach, describe, expect, test } from "bun:test";
import { renderForTty, renderMarkdownAnsi } from "../../src/output/markdown.ts";
import { detectMode, getMode, setMode } from "../../src/output/tty.ts";

const SAMPLE_BODY = "# Heading\n\nSome **bold** and *italic* and `code`.\n\n- one\n- two\n";

/**
 * Capture and restore the global output mode so tests that flip it for one
 * case don't leak into the next. The preload sets NO_COLOR=1, which gives
 * us a deterministic baseline to restore to.
 */
function withMode(mode: ReturnType<typeof detectMode>, fn: () => void): void {
	const prev = getMode();
	setMode(mode);
	try {
		fn();
	} finally {
		setMode(prev);
	}
}

describe("renderMarkdownAnsi", () => {
	test("emits ANSI escape codes for headings, bold, and inline code", () => {
		const out = renderMarkdownAnsi(SAMPLE_BODY);
		// Bun.markdown.ansi emits CSI escapes ("\x1b[") for styling — at minimum
		// we expect *some* escape sequences in the output for a styled doc.
		expect(out).toContain("\x1b[");
		expect(out).toContain("Heading");
		expect(out).toContain("bold");
		expect(out).toContain("code");
	});

	test("frontmatter is rendered as a colorized key:value block above the body", () => {
		const md = `---\nstate: open\nlabels:\n  - bug\n  - auth\n---\n\n# Title\n\nBody.\n`;
		const out = renderMarkdownAnsi(md);
		expect(out).toContain("state:");
		expect(out).toContain("open");
		expect(out).toContain("labels:");
		// Array values join with comma+space
		expect(out).toContain("bug, auth");
		// Body still renders
		expect(out).toContain("Title");
		expect(out).toContain("Body.");
	});

	test("text with no frontmatter renders just the body", () => {
		const out = renderMarkdownAnsi("# Hello\n\nworld");
		expect(out).toContain("Hello");
		expect(out).toContain("world");
		// No frontmatter keys
		expect(out).not.toContain("undefined:");
	});
});

describe("renderForTty", () => {
	afterEach(() => {
		// Restore preload baseline (NO_COLOR=1, non-interactive).
		setMode(detectMode());
	});

	test("raw=true returns the input verbatim regardless of mode", () => {
		withMode({ interactive: true, color: true, json: false, verbose: false, silent: false }, () => {
			expect(renderForTty(SAMPLE_BODY, true)).toBe(SAMPLE_BODY);
		});
	});

	test("non-interactive + non-color mode returns input verbatim even when raw=false", () => {
		withMode({ interactive: false, color: false, json: false, verbose: false, silent: false }, () => {
			expect(renderForTty(SAMPLE_BODY, false)).toBe(SAMPLE_BODY);
		});
	});

	test("interactive + color mode transforms the body", () => {
		withMode({ interactive: true, color: true, json: false, verbose: false, silent: false }, () => {
			const out = renderForTty(SAMPLE_BODY, false);
			expect(out).not.toBe(SAMPLE_BODY);
			expect(out).toContain("\x1b[");
		});
	});

	test("color enabled but not interactive (e.g. CI) returns input verbatim", () => {
		withMode({ interactive: false, color: true, json: false, verbose: false, silent: false }, () => {
			expect(renderForTty(SAMPLE_BODY, false)).toBe(SAMPLE_BODY);
		});
	});
});
