import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { clipToWidth, createProgress, renderBar } from "../../src/output/progress.ts";
import { getMode, type OutputMode, setMode } from "../../src/output/tty.ts";

interface WritableStream {
	write: (chunk: string | Uint8Array) => boolean;
}

function captureStderr(): { chunks: string[]; restore: () => void } {
	const chunks: string[] = [];
	const stream = process.stderr as unknown as WritableStream;
	const original = stream.write.bind(process.stderr);
	stream.write = (chunk: string | Uint8Array): boolean => {
		chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
		return true;
	};
	return {
		chunks,
		restore: () => {
			stream.write = original;
		},
	};
}

describe("renderBar", () => {
	test("empty when count is 0", () => {
		expect(renderBar(0, 10, 10)).toBe(`[${"░".repeat(10)}]`);
	});

	test("full when count equals total", () => {
		expect(renderBar(10, 10, 10)).toBe(`[${"█".repeat(10)}]`);
	});

	test("half-filled at 50%", () => {
		expect(renderBar(5, 10, 10)).toBe(`[${"█".repeat(5)}${"░".repeat(5)}]`);
	});

	test("handles zero total without dividing by zero", () => {
		expect(renderBar(0, 0, 6)).toBe(`[${"░".repeat(6)}]`);
	});

	test("clamps overshoot to width", () => {
		expect(renderBar(20, 10, 10)).toBe(`[${"█".repeat(10)}]`);
	});
});

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escape sequences requires \x1b
const ANSI_RE = /\x1b\[[0-9;]*m/g;

describe("clipToWidth", () => {
	const stripAnsi = (s: string) => s.replace(ANSI_RE, "");

	test("returns the string unchanged when shorter than width", () => {
		expect(stripAnsi(clipToWidth("hello", 10))).toBe("hello");
	});

	test("truncates plain text to fit width", () => {
		const out = clipToWidth("abcdefghij", 5);
		expect(stripAnsi(out)).toBe("abcde");
	});

	test("ANSI escape sequences don't count toward visible width", () => {
		// "abc" + green-on + "def" + reset. Clipping to 4 keeps "abcd".
		const styled = "abc\x1b[32mdef\x1b[0mghi";
		const out = clipToWidth(styled, 4);
		expect(stripAnsi(out)).toBe("abcd");
		// Style escape stays in the output even though it has no visible width.
		expect(out).toContain("\x1b[32m");
	});

	test("appends a reset escape so cut-mid-style doesn't leak color", () => {
		const styled = "\x1b[31mvery long red string here\x1b[0m";
		const out = clipToWidth(styled, 6);
		expect(out.endsWith("\x1b[0m")).toBe(true);
	});

	test("zero or negative width yields just a reset", () => {
		expect(clipToWidth("anything", 0)).toBe("\x1b[0m");
		expect(clipToWidth("anything", -3)).toBe("\x1b[0m");
	});
});

describe("createProgress", () => {
	let prevMode: OutputMode;

	beforeEach(() => {
		prevMode = getMode();
	});

	afterEach(() => {
		setMode(prevMode);
	});

	test("non-interactive tick emits one [N/M] line per call", () => {
		setMode({ interactive: false, color: false, json: false, verbose: false, silent: false });
		const cap = captureStderr();
		try {
			const p = createProgress();
			p.start(3, "ingest");
			p.tick("a");
			p.tick("b");
			p.tick("c");
			p.done("done 3/3");
		} finally {
			cap.restore();
		}
		const out = cap.chunks.join("");
		expect(out).toContain("[1/3] a");
		expect(out).toContain("[2/3] b");
		expect(out).toContain("[3/3] c");
		expect(out).toContain("done 3/3");
	});

	test("entry writes a persistent line in non-interactive mode", () => {
		setMode({ interactive: false, color: false, json: false, verbose: false, silent: false });
		const cap = captureStderr();
		try {
			const p = createProgress();
			p.start(2);
			p.tick("first");
			p.entry("✓ first/path");
			p.tick("second");
			p.entry("✓ second/path");
			p.done();
		} finally {
			cap.restore();
		}
		const out = cap.chunks.join("");
		expect(out).toContain("✓ first/path");
		expect(out).toContain("✓ second/path");
	});

	test("silent mode suppresses all progress output", () => {
		setMode({ interactive: false, color: false, json: false, verbose: false, silent: true });
		const cap = captureStderr();
		try {
			const p = createProgress();
			p.start(5, "ingest");
			p.tick("anything");
			p.entry("✓ anything");
			p.done("ingested 5/5");
		} finally {
			cap.restore();
		}
		expect(cap.chunks.join("")).toBe("");
	});

	test("update is a no-op in non-interactive mode", () => {
		setMode({ interactive: false, color: false, json: false, verbose: false, silent: false });
		const cap = captureStderr();
		try {
			const p = createProgress();
			p.start(2, "ingest");
			p.tick("file.md");
			const before = cap.chunks.length;
			p.update("embedding 16/64");
			p.update("embedding 32/64");
			expect(cap.chunks.length).toBe(before);
		} finally {
			cap.restore();
		}
	});

	test("update re-renders the live area with the last tick label and a suffix", () => {
		setMode({ interactive: true, color: false, json: false, verbose: false, silent: false });
		const cap = captureStderr();
		try {
			const p = createProgress();
			p.start(3, "ingest");
			p.tick("path/to/file.md");
			cap.chunks.length = 0;
			p.update("embedding 32/168");
			p.done();
			const out = cap.chunks.join("");
			expect(out).toContain("path/to/file.md");
			expect(out).toContain("embedding 32/168");
			expect(out).toContain("1/3");
		} finally {
			cap.restore();
		}
	});

	test("setWorkers + workerSet renders one line per worker slot", () => {
		setMode({ interactive: true, color: false, json: false, verbose: false, silent: false });
		const cap = captureStderr();
		try {
			const p = createProgress();
			p.start(4, "ingest");
			p.setWorkers(2);
			p.workerSet(0, "alpha.md — describing");
			p.workerSet(1, "beta.md — embedding 5/30");
			p.done();
			const out = cap.chunks.join("");
			expect(out).toContain("alpha.md — describing");
			expect(out).toContain("beta.md — embedding 5/30");
			// Separator row under the bar so the worker grid reads as its own block.
			expect(out).toContain("─");
		} finally {
			cap.restore();
		}
	});

	test("addChunks surfaces a running chunk total on the main line", () => {
		setMode({ interactive: true, color: false, json: false, verbose: false, silent: false });
		const cap = captureStderr();
		try {
			const p = createProgress();
			p.start(2, "ingest");
			p.tick("a");
			p.addChunks(12);
			p.tick("b");
			p.addChunks(7);
			p.done();
			const out = cap.chunks.join("");
			expect(out).toContain("19 chunks");
		} finally {
			cap.restore();
		}
	});
});
