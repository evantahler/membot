import { closeSync, existsSync, openSync, readSync, statSync, watch } from "node:fs";
import { join } from "node:path";
import { bold, cyan, dim, red, yellow } from "ansis";
import type { Command } from "commander";
import { defaultMembotHome, FILES } from "../constants.ts";
import { HelpfulError, isHelpfulError, mapKindToExit } from "../errors.ts";
import { renderCliError } from "../mount/commander.ts";
import { detectMode, setMode, useColor } from "../output/tty.ts";

/**
 * `membot logs [--follow] [--lines <n>] [--json]`
 *
 * Print (and optionally tail) the persistent serve-mode audit log written by
 * `membot serve`. The log file is `~/.membot/logs/serve.log` (one JSON record
 * per line: `{ts, level, msg, event?, tool?, ...}`). Defaults to pretty
 * `ts level tool msg` output; `--json` passes raw JSON lines straight to
 * stdout for `jq`-style processing.
 */
export function registerLogsCommand(program: Command): void {
	program
		.command("logs")
		.description("Print or tail the membot serve log (~/.membot/logs/serve.log)")
		.option("-f, --follow", "stream new lines as they're appended (tail -F)")
		.option("-n, --lines <n>", "number of trailing lines to print (default 100)", "100")
		.option("--raw", "emit raw JSON lines instead of the pretty format (alias of the global --json)")
		.action(async (options: { follow?: boolean; lines?: string; raw?: boolean }) => {
			const globalOpts = program.optsWithGlobals<{ json?: boolean; verbose?: boolean; color?: boolean }>();
			const rawJson = !!options.raw || !!globalOpts.json;
			setMode(
				detectMode({
					json: rawJson,
					verbose: globalOpts.verbose,
					noColor: globalOpts.color === false,
				}),
			);
			try {
				const logPath = join(defaultMembotHome(), FILES.LOGS_DIR, "serve.log");
				if (!existsSync(logPath)) {
					throw new HelpfulError({
						kind: "not_found",
						message: `no log file at ${logPath}`,
						hint: "Run `membot serve` first — the log file is created when the MCP server starts.",
					});
				}

				const lineCount = Number(options.lines ?? "100");
				if (!Number.isFinite(lineCount) || lineCount < 0) {
					throw new HelpfulError({
						kind: "input_error",
						message: `invalid --lines value: ${options.lines}`,
						hint: "Pass a non-negative integer, e.g. `--lines 50`.",
					});
				}

				const render = rawJson ? renderJson : renderPretty;
				const tail = readLastLines(logPath, lineCount);
				for (const line of tail) render(line);

				if (options.follow) {
					await followFile(logPath, statSync(logPath).size, render);
				}
			} catch (err) {
				renderCliError(err);
				process.exit(isHelpfulError(err) ? mapKindToExit(err.kind) : 1);
			}
		});
}

/** Read up to the last `n` newline-delimited lines from a file. Works on small or 100MB files. */
function readLastLines(path: string, n: number): string[] {
	if (n === 0) return [];
	const size = statSync(path).size;
	if (size === 0) return [];
	const chunk = 64 * 1024;
	const fd = openSync(path, "r");
	try {
		let position = size;
		let buffer = "";
		const lines: string[] = [];
		while (position > 0 && lines.length <= n) {
			const readLen = Math.min(chunk, position);
			position -= readLen;
			const buf = Buffer.alloc(readLen);
			readSync(fd, buf, 0, readLen, position);
			buffer = buf.toString("utf8") + buffer;
			const parts = buffer.split("\n");
			buffer = parts.shift() ?? "";
			lines.unshift(...parts.filter((l) => l.length > 0));
		}
		if (buffer.length > 0) lines.unshift(buffer);
		return lines.slice(-n);
	} finally {
		try {
			closeSync(fd);
		} catch {
			// best effort
		}
	}
}

/**
 * Tail `path` for new appended bytes. Uses `fs.watch` (inotify/FSEvents) and
 * falls back to polling stat() on the file size for resilience across
 * platforms. Re-opens on inode change so rotation doesn't strand the reader.
 */
async function followFile(path: string, startOffset: number, render: (line: string) => void): Promise<void> {
	let offset = startOffset;
	let pending = "";

	const readNew = () => {
		try {
			const size = statSync(path).size;
			if (size < offset) {
				// rotation happened — start from byte 0 of the new file
				offset = 0;
				pending = "";
			}
			if (size === offset) return;
			const fd = openSync(path, "r");
			try {
				const len = size - offset;
				const buf = Buffer.alloc(len);
				readSync(fd, buf, 0, len, offset);
				offset = size;
				pending += buf.toString("utf8");
				const parts = pending.split("\n");
				pending = parts.pop() ?? "";
				for (const line of parts) if (line.length > 0) render(line);
			} finally {
				try {
					closeSync(fd);
				} catch {
					// best effort
				}
			}
		} catch {
			// file may briefly not exist during rotation; ignore and retry on next tick
		}
	};

	const watcher = watch(path, { persistent: true }, readNew);
	// Backstop poll in case fs.watch misses an event (it sometimes does
	// across rotation or on network filesystems).
	const poll = setInterval(readNew, 1000);

	await new Promise<void>((resolve) => {
		process.once("SIGINT", () => {
			watcher.close();
			clearInterval(poll);
			resolve();
		});
		process.once("SIGTERM", () => {
			watcher.close();
			clearInterval(poll);
			resolve();
		});
	});
}

function renderJson(line: string): void {
	process.stdout.write(`${line}\n`);
}

interface LogRecord {
	ts?: string;
	level?: string;
	msg?: string;
	event?: string;
	tool?: string;
	[key: string]: unknown;
}

function renderPretty(line: string): void {
	let rec: LogRecord;
	try {
		rec = JSON.parse(line) as LogRecord;
	} catch {
		// Not a JSON line — emit verbatim so old / mixed lines aren't swallowed.
		process.stdout.write(`${line}\n`);
		return;
	}
	const color = useColor();
	const ts = rec.ts ?? "";
	const lvl = (rec.level ?? "info").padEnd(5);
	const lvlColored = color ? colorizeLevel(rec.level ?? "info", lvl) : lvl;
	const tag = rec.event ? `[${rec.event}${rec.tool ? ` ${rec.tool}` : ""}]` : "";
	const tagColored = color && tag ? cyan(tag) : tag;
	const msg = rec.msg ?? "";
	const head = [ts, lvlColored, tagColored, msg].filter((s) => s !== "").join(" ");
	process.stdout.write(`${head}\n`);
}

function colorizeLevel(level: string, padded: string): string {
	switch (level) {
		case "error":
			return red(bold(padded));
		case "warn":
			return yellow(padded);
		case "debug":
			return dim(padded);
		default:
			return padded;
	}
}
