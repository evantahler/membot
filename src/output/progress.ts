import { logger } from "./logger.ts";
import { useSpinner } from "./tty.ts";

/**
 * Minimal progress reporter for multi-entry operations (directory/glob ingest,
 * batch refresh). Operations call `start(total)`, then `tick(label)` for each
 * entry, then `done(summary)`.
 *
 * Interactive: replaces a single spinner line as work happens.
 * Non-interactive: emits `info` lines per entry.
 */
export interface Progress {
	start(total: number, label?: string): void;
	tick(label: string): void;
	done(summary?: string): void;
	fail(summary?: string): void;
	info(msg: string): void;
}

export function createProgress(): Progress {
	let total = 0;
	let count = 0;
	let spinner: ReturnType<typeof logger.startSpinner> | null = null;

	const interactive = useSpinner();

	return {
		start(t: number, label?: string) {
			total = t;
			count = 0;
			if (interactive) {
				spinner = logger.startSpinner(label ? `${label} (0/${total})` : `0/${total}`);
			} else if (label) {
				logger.info(label);
			}
		},
		tick(label: string) {
			count += 1;
			if (interactive && spinner) {
				spinner.update(`${count}/${total} — ${label}`);
			} else {
				logger.info(`[${count}/${total}] ${label}`);
			}
		},
		done(summary?: string) {
			if (interactive && spinner) {
				spinner.success(summary ?? `${count}/${total} done`);
				spinner = null;
			} else if (summary) {
				logger.info(summary);
			}
		},
		fail(summary?: string) {
			if (interactive && spinner) {
				spinner.error(summary ?? `failed at ${count}/${total}`);
				spinner = null;
			} else if (summary) {
				logger.warn(summary);
			}
		},
		info(msg: string) {
			logger.info(msg);
		},
	};
}
