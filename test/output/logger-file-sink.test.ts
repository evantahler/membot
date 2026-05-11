import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "../../src/output/logger.ts";
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

interface ParsedLine {
	ts?: string;
	level?: string;
	msg?: string;
	[k: string]: unknown;
}

function readLines(path: string): ParsedLine[] {
	const raw = readFileSync(path, "utf8");
	return raw
		.split("\n")
		.filter((l) => l.length > 0)
		.map((l) => JSON.parse(l) as ParsedLine);
}

describe("logger file sink", () => {
	let prevMode: OutputMode;
	let dir: string;
	let logPath: string;

	beforeEach(() => {
		prevMode = getMode();
		dir = mkdtempSync(join(tmpdir(), "membot-logger-"));
		logPath = join(dir, "serve.log");
	});

	afterEach(() => {
		logger.detachFileSink();
		setMode(prevMode);
	});

	test("captures info/warn/error/debug records with structured fields", () => {
		setMode({ interactive: false, color: false, json: false, verbose: true, silent: false });
		logger.attachFileSink(logPath);
		logger.info("first");
		logger.warn("second");
		logger.error("third");
		logger.debug("fourth");
		logger.detachFileSink();

		const lines = readLines(logPath);
		expect(lines.map((l) => l.level)).toEqual(["info", "warn", "error", "debug"]);
		expect(lines.map((l) => l.msg)).toEqual(["first", "second", "third", "fourth"]);
		for (const line of lines) {
			expect(typeof line.ts).toBe("string");
			expect(line.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		}
	});

	test("event() merges structured extras into the record", () => {
		setMode({ interactive: false, color: false, json: false, verbose: false, silent: false });
		logger.attachFileSink(logPath);
		logger.event("info", "tool call", {
			event: "mcp.call.ok",
			tool: "membot_search",
			duration_ms: 12,
			arg_keys: ["query", "limit"],
		});
		logger.detachFileSink();

		const [line] = readLines(logPath);
		expect(line?.event).toBe("mcp.call.ok");
		expect(line?.tool).toBe("membot_search");
		expect(line?.duration_ms).toBe(12);
		expect(line?.arg_keys).toEqual(["query", "limit"]);
	});

	test("file sink writes even when stderr is suppressed by JSON mode", () => {
		// MCP serve mode: json=true → stderr silenced for info, but file must capture.
		setMode({ interactive: false, color: false, json: true, verbose: false, silent: false });
		logger.attachFileSink(logPath);

		const cap = captureStderr();
		try {
			logger.info("audit only");
			logger.event("info", "tool call", { event: "mcp.call.ok", tool: "x" });
		} finally {
			cap.restore();
		}
		logger.detachFileSink();

		// Stderr saw nothing (info suppressed in JSON mode).
		expect(cap.chunks.join("")).toBe("");
		// File saw both records.
		const lines = readLines(logPath);
		expect(lines.map((l) => l.msg)).toEqual(["audit only", "tool call"]);
		expect(lines[1]?.event).toBe("mcp.call.ok");
	});

	test("rotates when bytesSinceOpen exceeds rotateBytes", () => {
		setMode({ interactive: false, color: false, json: true, verbose: false, silent: false });
		logger.attachFileSink(logPath, { rotateBytes: 200, rotateKeep: 2 });
		// Each record is ~80 bytes; write enough to force at least one rotation.
		for (let i = 0; i < 10; i++) logger.info(`msg-${i}`);
		logger.detachFileSink();

		const files = readdirSync(dir).sort();
		expect(files).toContain("serve.log");
		expect(files).toContain("serve.log.1");
		// Records distributed across files — at least one rolled-over file exists.
		const all = files
			.filter((f) => f.startsWith("serve.log"))
			.flatMap((f) => readLines(join(dir, f)).map((l) => l.msg));
		expect(all).toHaveLength(10);
	});

	test("detachFileSink is idempotent", () => {
		logger.detachFileSink();
		logger.detachFileSink();
		// no throw → pass
		expect(true).toBe(true);
	});
});
