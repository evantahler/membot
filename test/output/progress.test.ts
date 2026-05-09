import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { logger, type Spinner } from "../../src/output/logger.ts";
import { createProgress, renderBar } from "../../src/output/progress.ts";
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

	test("update re-renders the spinner with the last tick label and a suffix", () => {
		setMode({ interactive: true, color: false, json: false, verbose: false, silent: false });
		const updates: string[] = [];
		const fakeSpinner: Spinner = {
			update: (t) => updates.push(t),
			success: () => {},
			error: () => {},
			stop: () => {},
		};
		const original = logger.startSpinner.bind(logger);
		logger.startSpinner = ((text: string) => {
			updates.push(text);
			return fakeSpinner;
		}) as typeof logger.startSpinner;
		try {
			const p = createProgress();
			p.start(3, "ingest");
			p.tick("path/to/file.md");
			updates.length = 0;
			p.update("embedding 32/168");
			expect(updates.length).toBe(1);
			const text = updates[0] ?? "";
			expect(text).toContain("path/to/file.md");
			expect(text).toContain("embedding 32/168");
			expect(text).toContain("1/3");
		} finally {
			logger.startSpinner = original;
		}
	});
});
