import { closeSync, existsSync, mkdirSync, openSync, renameSync, statSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { dim, red, yellow } from "ansis";
import { createSpinner } from "nanospinner";
import { DEFAULTS } from "../constants.ts";
import { getMode, isJson, isSilent, isVerbose, useColor, useSpinner } from "./tty.ts";

export interface Spinner {
	update(text: string): void;
	success(text?: string): void;
	error(text?: string): void;
	stop(): void;
}

/**
 * Anything occupying a fixed area of stderr that needs to be torn down before
 * the logger writes a stray line, then redrawn afterward. nanospinner's
 * single-line spinner and progress.ts's multi-line worker view both implement
 * this so log/info/warn lines don't shred the live display.
 */
export interface LiveArea {
	clear(): void;
	render(): void;
}

const NOOP_SPINNER: Spinner = { update() {}, success() {}, error() {}, stop() {} };

export type LogLevel = "debug" | "info" | "warn" | "error";

interface FileSink {
	path: string;
	fd: number;
	bytesSinceOpen: number;
	rotateBytes: number;
	rotateKeep: number;
}

/**
 * Process-wide singleton that owns stderr writes. All output is spinner-aware
 * (clears the active spinner line, writes, then re-renders) so log lines don't
 * shred a running progress indicator. Honors JSON, verbose, and color modes
 * decided in `tty.ts` so callers never have to branch on environment.
 *
 * An optional file sink (attached by `membot serve`) receives a JSON line for
 * every log call regardless of stderr suppression rules, so the audit trail
 * stays complete even when the MCP host runs the server in JSON mode.
 */
class Logger {
	private static instance: Logger;
	private activeSpinner: ReturnType<typeof createSpinner> | null = null;
	private activeLiveArea: LiveArea | null = null;
	private fileSink: FileSink | null = null;

	/** Singleton accessor. Use the exported `logger` const instead in normal code. */
	static getInstance(): Logger {
		if (!Logger.instance) Logger.instance = new Logger();
		return Logger.instance;
	}

	private color(fn: (s: string) => string, msg: string): string {
		return useColor() ? fn(msg) : msg;
	}

	/**
	 * Register a multi-line live display. Logger will `clear()` it before any
	 * stderr write and `render()` it after, so log lines don't punch through
	 * the live area. Pass null to deregister. Mutually exclusive with the
	 * nanospinner path (only one live thing on stderr at a time).
	 */
	setActiveLiveArea(area: LiveArea | null): void {
		this.activeLiveArea = area;
	}

	/**
	 * Open a file sink that receives a JSON-per-line audit record for every
	 * log call — independent of whether the line is also rendered to stderr.
	 * Used by `membot serve` to persist `~/.membot/logs/serve.log`. Opens in
	 * append mode; if the file already exists, its size seeds the rotation
	 * counter so a long-lived install rolls over predictably.
	 */
	attachFileSink(path: string, options: { rotateBytes?: number; rotateKeep?: number } = {}): void {
		if (this.fileSink) this.detachFileSink();
		mkdirSync(dirname(path), { recursive: true });
		const fd = openSync(path, "a");
		const bytesSinceOpen = statSync(path).size;
		this.fileSink = {
			path,
			fd,
			bytesSinceOpen,
			rotateBytes: options.rotateBytes ?? DEFAULTS.SERVE_LOG_ROTATE_BYTES,
			rotateKeep: options.rotateKeep ?? DEFAULTS.SERVE_LOG_ROTATE_KEEP,
		};
	}

	/** Flush + close the file sink (idempotent). */
	detachFileSink(): void {
		if (!this.fileSink) return;
		try {
			closeSync(this.fileSink.fd);
		} catch {
			// best effort
		}
		this.fileSink = null;
	}

	private writeStderr(msg: string): void {
		const area = this.activeLiveArea;
		if (area) {
			area.clear();
			process.stderr.write(`${msg}\n`);
			area.render();
			return;
		}
		if (this.activeSpinner) {
			this.activeSpinner.clear();
			process.stderr.write(`${msg}\n`);
			this.activeSpinner.render();
		} else {
			process.stderr.write(`${msg}\n`);
		}
	}

	private writeFile(level: LogLevel, msg: string, extra?: Record<string, unknown>): void {
		const sink = this.fileSink;
		if (!sink) return;
		const record = JSON.stringify({
			ts: new Date().toISOString(),
			level,
			msg,
			...(extra ?? {}),
		});
		const line = `${record}\n`;
		try {
			writeSync(sink.fd, line);
		} catch {
			// best effort — never let a logging failure crash the process
			return;
		}
		sink.bytesSinceOpen += Buffer.byteLength(line);
		if (sink.bytesSinceOpen >= sink.rotateBytes) this.rotateFileSink();
	}

	/**
	 * Size-based rotation: rename `serve.log.{N-1}` → `serve.log.{N}` from
	 * the tail in, drop anything past `rotateKeep`, rename the live file to
	 * `serve.log.1`, then re-open a fresh `serve.log`. Synchronous so two
	 * concurrent log lines can't both try to rotate at once.
	 */
	private rotateFileSink(): void {
		const sink = this.fileSink;
		if (!sink) return;
		try {
			closeSync(sink.fd);
		} catch {
			// best effort
		}
		for (let i = sink.rotateKeep; i >= 1; i--) {
			const src = i === 1 ? sink.path : `${sink.path}.${i - 1}`;
			const dst = `${sink.path}.${i}`;
			if (!existsSync(src)) continue;
			try {
				renameSync(src, dst);
			} catch {
				// best effort
			}
		}
		const fd = openSync(sink.path, "a");
		this.fileSink = { ...sink, fd, bytesSinceOpen: 0 };
	}

	private emit(level: LogLevel, msg: string, extra: Record<string, unknown> | undefined, renderable: string): void {
		this.writeFile(level, msg, extra);
		switch (level) {
			case "info":
				if (isJson() || isSilent()) return;
				this.writeStderr(this.color(dim, renderable));
				return;
			case "warn":
				if (isJson()) return;
				this.writeStderr(this.color(yellow, renderable));
				return;
			case "error":
				this.writeStderr(this.color(red, renderable));
				return;
			case "debug":
				if (!isVerbose() || isJson()) return;
				this.writeStderr(this.color(dim, renderable));
				return;
		}
	}

	/** Advisory info — stderr in interactive, suppressed in JSON or silent (CI/test). File sink (if attached) always receives the record. */
	info(msg: string): void {
		this.emit("info", msg, undefined, msg);
	}

	/** Advisory warn — yellow on TTY, suppressed in JSON mode. File sink (if attached) always receives the record. */
	warn(msg: string): void {
		this.emit("warn", msg, undefined, msg);
	}

	/** Errors always print, even in JSON mode (stderr won't break parseable stdout). File sink (if attached) also receives the record. */
	error(msg: string): void {
		this.emit("error", msg, undefined, msg);
	}

	/** Verbose-only debug. Silent unless `--verbose` is set, and always silent in JSON mode. File sink (if attached) always receives the record. */
	debug(msg: string): void {
		this.emit("debug", msg, undefined, msg);
	}

	/**
	 * Structured event variant: same stderr behavior as info/warn/error/debug
	 * (gated by the active mode) but the file sink receives both `msg` and
	 * the `extra` fields as a single JSON record. Use for audit lines where
	 * the human-readable form is fine on stderr but downstream tooling wants
	 * the structured shape (`{event, tool, duration_ms, ...}`) in the file.
	 */
	event(level: LogLevel, msg: string, extra: Record<string, unknown>): void {
		this.emit(level, msg, extra, msg);
	}

	/** Raw stderr write, no formatting added. Spinner-aware. Bypasses the file sink. */
	writeRaw(msg: string): void {
		const area = this.activeLiveArea;
		if (area) {
			area.clear();
			process.stderr.write(msg);
			area.render();
			return;
		}
		if (this.activeSpinner) {
			this.activeSpinner.clear();
			process.stderr.write(msg);
			this.activeSpinner.render();
		} else {
			process.stderr.write(msg);
		}
	}

	/**
	 * Start a stderr spinner. Returns a `Spinner` controller in interactive
	 * mode; in JSON / piped / `CI=true` / `NO_COLOR` environments it returns
	 * a no-op so call sites can use the same code path either way.
	 */
	startSpinner(text: string): Spinner {
		if (!useSpinner()) return NOOP_SPINNER;

		const spinner = createSpinner(text, { stream: process.stderr }).start();
		this.activeSpinner = spinner;

		return {
			update: (t: string) => {
				spinner.update({ text: t });
			},
			success: (t?: string) => {
				spinner.success({ text: t });
				if (this.activeSpinner === spinner) this.activeSpinner = null;
			},
			error: (t?: string) => {
				spinner.error({ text: t });
				if (this.activeSpinner === spinner) this.activeSpinner = null;
			},
			stop: () => {
				spinner.stop();
				if (this.activeSpinner === spinner) this.activeSpinner = null;
			},
		};
	}

	/** True when the logger should emit human output (used by progress). */
	humanOutput(): boolean {
		return !isJson() && !isSilent() && getMode().interactive;
	}
}

export const logger = Logger.getInstance();
