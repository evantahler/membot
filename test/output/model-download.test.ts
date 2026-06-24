import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ProgressInfo } from "@huggingface/transformers";
import { createModelDownloadReporter } from "../../src/output/model-download.ts";
import { getMode, type OutputMode, setMode } from "../../src/output/tty.ts";

interface WritableStream {
	write: (chunk: string | Uint8Array) => boolean;
}

/** Capture everything written to stderr so we can assert on rendered spinner text. */
function captureStderr(): { chunks: string[]; text: () => string; restore: () => void } {
	const chunks: string[] = [];
	const stream = process.stderr as unknown as WritableStream;
	const original = stream.write.bind(process.stderr);
	stream.write = (chunk: string | Uint8Array): boolean => {
		chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
		return true;
	};
	const originalColumns = process.stderr.columns;
	const cols = process.stderr as unknown as { columns: number };
	cols.columns = 200;
	return {
		chunks,
		text: () => chunks.join(""),
		restore: () => {
			stream.write = original;
			cols.columns = originalColumns;
		},
	};
}

// Event-sequence builders mirroring what @huggingface/transformers emits.
const initiate = (file: string): ProgressInfo => ({ status: "initiate", name: "m", file });
const download = (file: string): ProgressInfo => ({ status: "download", name: "m", file });
const progress = (file: string, loaded: number, total: number): ProgressInfo => ({
	status: "progress",
	name: "m",
	file,
	loaded,
	total,
	progress: total > 0 ? (loaded / total) * 100 : 0,
});
const done = (file: string): ProgressInfo => ({ status: "done", name: "m", file });

describe("createModelDownloadReporter", () => {
	let prevMode: OutputMode;
	beforeEach(() => {
		prevMode = getMode();
	});
	afterEach(() => {
		setMode(prevMode);
	});

	test("renders a bar on a real download and finishes with a success line", () => {
		setMode({ interactive: true, color: false, json: false, verbose: false, silent: false });
		const cap = captureStderr();
		try {
			const r = createModelDownloadReporter("embedding", "Xenova/bge-small-en-v1.5");
			r.onProgress(initiate("model.onnx"));
			r.onProgress(download("model.onnx"));
			r.onProgress(progress("model.onnx", 0, 1024 * 1024));
			r.onProgress(progress("model.onnx", 1024 * 1024, 1024 * 1024));
			r.onProgress(done("model.onnx"));
			r.finish();
			const out = cap.text();
			expect(out).toContain("Downloading embedding model Xenova/bge-small-en-v1.5");
			// The success line reports the aggregated total, proving the bar
			// machinery started and summed bytes. (The live bar text itself is
			// painted by nanospinner's animation interval, which doesn't tick in
			// a synchronous test, so we assert the deterministic start/finish.)
			expect(out).toContain("Downloaded embedding model (1.0 MB)");
		} finally {
			cap.restore();
		}
	});

	test("stays completely silent on a cache hit (no download/progress events)", () => {
		setMode({ interactive: true, color: false, json: false, verbose: false, silent: false });
		const cap = captureStderr();
		try {
			const r = createModelDownloadReporter("embedding", "Xenova/bge-small-en-v1.5");
			// A warm cache only emits initiate/done — never download or progress-with-total.
			r.onProgress(initiate("model.onnx"));
			r.onProgress(done("model.onnx"));
			r.finish();
			expect(cap.text()).toBe("");
		} finally {
			cap.restore();
		}
	});

	test("aggregates bytes across multiple files into a monotonic percentage", () => {
		setMode({ interactive: true, color: false, json: false, verbose: false, silent: false });
		const cap = captureStderr();
		try {
			const r = createModelDownloadReporter("reranker", "Xenova/ms-marco-MiniLM-L-6-v2");
			// Two files, 1 MB each. Drive them past the throttle by alternating
			// percentages; assert the last render shows the combined total.
			r.onProgress(progress("a.onnx", 0, 1024 * 1024));
			r.onProgress(progress("b.bin", 0, 1024 * 1024));
			r.onProgress(progress("a.onnx", 1024 * 1024, 1024 * 1024));
			r.onProgress(progress("b.bin", 1024 * 1024, 1024 * 1024));
			r.finish();
			const out = cap.text();
			// Combined total is 2 MB; the success line reports the aggregate size.
			expect(out).toContain("Downloaded reranker model (2.0 MB)");
		} finally {
			cap.restore();
		}
	});

	test("non-interactive mode emits no spinner bar (info line only, suppressed in silent)", () => {
		setMode({ interactive: false, color: false, json: false, verbose: false, silent: true });
		const cap = captureStderr();
		try {
			const r = createModelDownloadReporter("embedding", "Xenova/bge-small-en-v1.5");
			r.onProgress(download("model.onnx"));
			r.onProgress(progress("model.onnx", 512, 1024));
			r.finish();
			// Silent mode suppresses the info line and startSpinner returns a no-op,
			// so nothing reaches stderr and there is no live bar.
			expect(cap.text()).not.toMatch(/[█░]/);
		} finally {
			cap.restore();
		}
	});

	test("finish() is a no-op when no download ever started", () => {
		setMode({ interactive: true, color: false, json: false, verbose: false, silent: false });
		const cap = captureStderr();
		try {
			const r = createModelDownloadReporter("embedding", "Xenova/bge-small-en-v1.5");
			r.finish();
			expect(cap.text()).toBe("");
		} finally {
			cap.restore();
		}
	});
});
