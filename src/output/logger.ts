import { dim, red, yellow } from "ansis";
import { createSpinner } from "nanospinner";
import { getMode, isJson, isVerbose, useColor, useSpinner } from "./tty.ts";

export interface Spinner {
	update(text: string): void;
	success(text?: string): void;
	error(text?: string): void;
	stop(): void;
}

const NOOP_SPINNER: Spinner = { update() {}, success() {}, error() {}, stop() {} };

class Logger {
	private static instance: Logger;
	private activeSpinner: ReturnType<typeof createSpinner> | null = null;

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

	/** Advisory info — stderr in interactive, suppressed in JSON, kept in CI. */
	info(msg: string): void {
		if (isJson()) return;
		this.writeStderr(this.color(dim, msg));
	}

	warn(msg: string): void {
		if (isJson()) return;
		this.writeStderr(this.color(yellow, msg));
	}

	/** Errors always print, even in JSON mode (stderr won't break parseable stdout). */
	error(msg: string): void {
		this.writeStderr(this.color(red, msg));
	}

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
		return !isJson() && getMode().interactive;
	}
}

export const logger = Logger.getInstance();
