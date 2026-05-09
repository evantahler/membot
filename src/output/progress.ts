import { logger } from "./logger.ts";
import { isSilent, useSpinner } from "./tty.ts";

/**
 * Progress reporter for multi-entry operations (directory/glob ingest, batch
 * refresh, multi-source `add`). Operations call `start(total)`, then for each
 * entry call `tick(label)` (advances the in-flight indicator) and optionally
 * `entry(line)` (writes a persistent stderr line that survives the spinner),
 * then `done(summary)`.
 *
 * Interactive: replaces a single spinner line as work happens, with an ASCII
 * bar like `[████░░░░░░] 4/15 (26%) — relative/path.md`.
 * Non-interactive: emits `info` lines per `tick` and per `entry`.
 */
export interface Progress {
	start(total: number, label?: string): void;
	tick(label: string): void;
	/**
	 * Replace the spinner's main label without advancing the counter. Used to
	 * show which entry is currently being worked on while sub-step progress
	 * (the suffix) updates independently. No-op in non-interactive modes.
	 */
	setLabel(label: string): void;
	/**
	 * Re-render the active spinner with the most recent `tick` label plus an
	 * extra suffix (e.g. "embedding 32/168") without advancing the counter.
	 * No-op in non-interactive / silent / JSON modes — sub-step progress is
	 * deliberately TTY-only so CI logs don't get one line per inner batch.
	 */
	update(suffix: string): void;
	entry(line: string): void;
	done(summary?: string): void;
	fail(summary?: string): void;
	info(msg: string): void;
}

const BAR_WIDTH = 20;
const LABEL_MAX = 60;

/**
 * Render a fixed-width ASCII progress bar. Uses block-drawing characters in
 * interactive mode so the bar reads naturally next to other unicode glyphs.
 */
export function renderBar(count: number, total: number, width = BAR_WIDTH): string {
	if (total <= 0) return `[${"░".repeat(width)}]`;
	const ratio = Math.min(1, Math.max(0, count / total));
	const filled = Math.round(ratio * width);
	return `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`;
}

/**
 * Truncate a label from the left so the most-specific tail of a long path
 * stays visible. Keeps the spinner line on a single terminal row.
 */
function truncateLabel(label: string, max = LABEL_MAX): string {
	if (label.length <= max) return label;
	return `…${label.slice(label.length - max + 1)}`;
}

/**
 * Build a `Progress` reporter whose mode is decided once, at call time, from
 * the current TTY state. Use one per multi-entry operation.
 */
export function createProgress(): Progress {
	let total = 0;
	let count = 0;
	let lastLabel = "";
	let spinner: ReturnType<typeof logger.startSpinner> | null = null;

	const interactive = useSpinner();
	const silent = isSilent();

	const renderSpinnerText = (label: string, suffix?: string): string => {
		const bar = renderBar(count, total);
		const pct = total > 0 ? Math.floor((count / total) * 100) : 0;
		const labelTail = label ? ` — ${truncateLabel(label)}` : "";
		const suffixTail = suffix ? ` — ${suffix}` : "";
		return `${bar} ${count}/${total} (${pct}%)${labelTail}${suffixTail}`;
	};

	return {
		start(t: number, label?: string) {
			total = t;
			count = 0;
			lastLabel = label ?? "";
			if (silent) return;
			if (interactive) {
				const initial = renderSpinnerText(lastLabel);
				spinner = logger.startSpinner(initial);
			} else if (label) {
				logger.info(`${label}: 0/${total}`);
			}
		},
		tick(label: string) {
			count += 1;
			lastLabel = label;
			if (silent) return;
			if (interactive && spinner) {
				spinner.update(renderSpinnerText(label));
			} else {
				logger.info(`[${count}/${total}] ${label}`);
			}
		},
		setLabel(label: string) {
			lastLabel = label;
			if (silent) return;
			if (!interactive || !spinner) return;
			spinner.update(renderSpinnerText(label));
		},
		update(suffix: string) {
			if (silent) return;
			if (!interactive || !spinner) return;
			spinner.update(renderSpinnerText(lastLabel, suffix));
		},
		entry(line: string) {
			if (silent) return;
			logger.info(line);
		},
		done(summary?: string) {
			if (silent) return;
			if (interactive && spinner) {
				spinner.success(summary ?? `${count}/${total} done`);
				spinner = null;
			} else if (summary) {
				logger.info(summary);
			}
		},
		fail(summary?: string) {
			if (silent) {
				if (summary) logger.warn(summary);
				return;
			}
			if (interactive && spinner) {
				spinner.error(summary ?? `failed at ${count}/${total}`);
				spinner = null;
			} else if (summary) {
				logger.warn(summary);
			}
		},
		info(msg: string) {
			if (silent) return;
			logger.info(msg);
		},
	};
}
