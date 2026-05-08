import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { logger } from "../../src/output/logger.ts";
import { getMode, type OutputMode, setMode } from "../../src/output/tty.ts";

interface WritableStream {
	write: (chunk: string | Uint8Array) => boolean;
}

/**
 * Capture stderr writes from the logger by monkey-patching process.stderr.write.
 * Returns the captured chunks plus a restorer.
 */
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

describe("logger silent mode", () => {
	let prevMode: OutputMode;

	beforeEach(() => {
		prevMode = getMode();
	});

	afterEach(() => {
		setMode(prevMode);
	});

	test("info is suppressed when silent", () => {
		setMode({ interactive: false, color: false, json: false, verbose: false, silent: true });
		const cap = captureStderr();
		try {
			logger.info("should-not-appear");
		} finally {
			cap.restore();
		}
		expect(cap.chunks.join("")).toBe("");
	});

	test("debug is suppressed when silent (and not verbose)", () => {
		setMode({ interactive: false, color: false, json: false, verbose: false, silent: true });
		const cap = captureStderr();
		try {
			logger.debug("should-not-appear");
		} finally {
			cap.restore();
		}
		expect(cap.chunks.join("")).toBe("");
	});

	test("warn still prints when silent", () => {
		setMode({ interactive: false, color: false, json: false, verbose: false, silent: true });
		const cap = captureStderr();
		try {
			logger.warn("warning-message");
		} finally {
			cap.restore();
		}
		expect(cap.chunks.join("")).toContain("warning-message");
	});

	test("error always prints when silent", () => {
		setMode({ interactive: false, color: false, json: false, verbose: false, silent: true });
		const cap = captureStderr();
		try {
			logger.error("boom");
		} finally {
			cap.restore();
		}
		expect(cap.chunks.join("")).toContain("boom");
	});

	test("info prints when not silent", () => {
		setMode({ interactive: false, color: false, json: false, verbose: false, silent: false });
		const cap = captureStderr();
		try {
			logger.info("should-appear");
		} finally {
			cap.restore();
		}
		expect(cap.chunks.join("")).toContain("should-appear");
	});

	test("humanOutput is false when silent", () => {
		setMode({ interactive: true, color: false, json: false, verbose: false, silent: true });
		expect(logger.humanOutput()).toBe(false);
	});
});
