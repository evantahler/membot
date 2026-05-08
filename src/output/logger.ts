import { dim, red, yellow } from "ansis";
import { createSpinner } from "nanospinner";
import { getMode, isJson, isSilent, isVerbose, useColor, useSpinner } from "./tty.ts";

export interface Spinner {
	update(text: string): void;
	success(text?: string): void;
	error(text?: string): void;
	stop(): void;
}

const NOOP_SPINNER: Spinner = { update() {}, success() {}, error() {}, stop() {} };

/**
 * Process-wide singleton that owns stderr writes. All output is spinner-aware
 * (clears the active spinner line, writes, then re-renders) so log lines don't
 * shred a running progress indicator. Honors JSON, verbose, and color modes
 * decided in `tty.ts` so callers never have to branch on environment.
 */
class Logger {
	private static instance: Logger;
	private activeSpinner: ReturnType<typeof createSpinner> | null = null;

	/** Singleton accessor. Use the exported `logger` const instead in normal code. */
	static getInstance(): Logger {
		if (!Logger.instance) Logger.instance = new Logger();
		return Logger.instance;
	}

	private color(fn: (s: string) => string, msg: string): string {
		return useColor() ? fn(msg) : msg;
	}

	private writeStderr(msg: string): void {
		if (this.activeSpinner) {
			this.activeSpinner.clear();
			process.stderr.write(`${msg}\n`);
			this.activeSpinner.render();
		} else {
			process.stderr.write(`${msg}\n`);
		}
	}

	/** Advisory info — stderr in interactive, suppressed in JSON or silent (CI/test). */
	info(msg: string): void {
		if (isJson() || isSilent()) return;
		this.writeStderr(this.color(dim, msg));
	}

	/** Advisory warn — yellow on TTY, suppressed in JSON mode. */
	warn(msg: string): void {
		if (isJson()) return;
		this.writeStderr(this.color(yellow, msg));
	}

	/** Errors always print, even in JSON mode (stderr won't break parseable stdout). */
	error(msg: string): void {
		this.writeStderr(this.color(red, msg));
	}

	/** Verbose-only debug. Silent unless `--verbose` is set, and always silent in JSON mode. */
	debug(msg: string): void {
		if (!isVerbose() || isJson()) return;
		this.writeStderr(this.color(dim, msg));
	}

	/** Raw stderr write, no formatting added. Spinner-aware. */
	writeRaw(msg: string): void {
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
