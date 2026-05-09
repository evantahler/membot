import { dim } from "ansis";
import { type LiveArea, logger } from "./logger.ts";
import { isSilent, useColor, useSpinner } from "./tty.ts";

/**
 * Progress reporter for multi-entry operations (directory/glob ingest, batch
 * refresh, multi-source `add`). Operations call `start(total)`, then for each
 * entry call `tick(label)` (advances the in-flight indicator) and optionally
 * `entry(line)` (writes a persistent stderr line that survives the spinner),
 * then `done(summary)`.
 *
 * Interactive: a multi-line live area on stderr — top is the bar with
 * counts, ETA, and chunk total; below it, one line per active worker showing
 * which file and which step it's currently on. Updates redraw in place via
 * ANSI escapes.
 *
 * Non-interactive: emits `info` lines per `tick` and per `entry` and
 * silently ignores worker / chunk updates so CI logs don't get spammed.
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
	/**
	 * Resize the worker section of the multi-line display to `n` slots. Each
	 * slot is then addressable via `workerSet(workerId, line)`. Pass 0 to
	 * collapse the worker section (single-line bar only). No-op in
	 * non-interactive modes.
	 */
	setWorkers(n: number): void;
	/**
	 * Set worker `workerId`'s status line (e.g. "doc.md — embedding 12/30").
	 * Empty string marks the slot idle. No-op in non-interactive modes.
	 */
	workerSet(workerId: number, line: string): void;
	/**
	 * Increment the cumulative chunk count rendered on the top line. Called
	 * by ingest workers after persisting each file. No-op in non-interactive.
	 */
	addChunks(n: number): void;
	entry(line: string): void;
	done(summary?: string): void;
	fail(summary?: string): void;
	info(msg: string): void;
}

const BAR_WIDTH = 20;
const LABEL_MAX = 60;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FRAME_INTERVAL_MS = 80;
const PIE_FRAMES = ["◯", "◔", "◐", "◕", "●"] as const;

/**
 * Map a pipeline step name to a single-character "pie" indicator showing
 * roughly how far along the per-file pipeline is. The full path is
 * read → unchanged check → convert → describe → chunk → embed → persist;
 * each step lights up another quarter. Embed is the slow one and reports
 * its own `embedding X/Y` sub-progress, which we render with a finer-
 * grained pie based on the X/Y ratio.
 */
export function pieFor(step: string | undefined): string {
	if (!step) return PIE_FRAMES[0];
	const m = step.match(/^embedding\s+(\d+)\s*\/\s*(\d+)/);
	if (m) {
		const done = Number(m[1]);
		const total = Number(m[2]);
		if (total > 0) return pieFromRatio(done / total);
	}
	switch (step) {
		case "reading":
			return PIE_FRAMES[0];
		case "converting":
			return PIE_FRAMES[1];
		case "describing":
			return PIE_FRAMES[2];
		case "chunking":
			return PIE_FRAMES[3];
		case "persisting":
			return PIE_FRAMES[4];
		default:
			return PIE_FRAMES[0];
	}
}

function pieFromRatio(r: number): string {
	if (r < 0.125) return PIE_FRAMES[0];
	if (r < 0.375) return PIE_FRAMES[1];
	if (r < 0.625) return PIE_FRAMES[2];
	if (r < 0.875) return PIE_FRAMES[3];
	return PIE_FRAMES[4];
}

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
 * Cap a (possibly ANSI-styled) string at `width` *visible* columns. ANSI
 * escape sequences are passed through verbatim — they don't count toward
 * width — and a `\x1b[0m` reset is appended so any open formatting closes
 * cleanly even if we cut mid-styled-substring. Critical for the multi-line
 * live area: if a line wraps to two terminal rows, our cursor math (one
 * `\x1b[1A` per logical line) leaves wrap residue behind on every clear,
 * which is what produces the "double-write / scrolling" artifact.
 */
export function clipToWidth(s: string, width: number): string {
	if (width <= 0) return "\x1b[0m";
	let visible = 0;
	let i = 0;
	let out = "";
	while (i < s.length) {
		if (s[i] === "\x1b" && s[i + 1] === "[") {
			let j = i + 2;
			while (j < s.length && s[j] !== "m") j++;
			if (j < s.length) {
				out += s.slice(i, j + 1);
				i = j + 1;
				continue;
			}
		}
		if (visible >= width) break;
		out += s[i];
		visible++;
		i++;
	}
	return `${out}\x1b[0m`;
}

/** Best-effort terminal width; falls back to 80 when stderr is not a TTY. */
function terminalWidth(): number {
	const cols = process.stderr.columns;
	if (typeof cols === "number" && cols > 0) return cols;
	return 80;
}

/**
 * Format a millisecond duration as a short human string: `47s`, `2m13s`,
 * `1h12m`. Used for the ETA on the top line.
 */
function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "?";
	const sec = Math.round(ms / 1000);
	if (sec < 60) return `${sec}s`;
	const min = Math.floor(sec / 60);
	const remSec = sec % 60;
	if (min < 60) return remSec === 0 ? `${min}m` : `${min}m${remSec}s`;
	const hr = Math.floor(min / 60);
	const remMin = min % 60;
	return remMin === 0 ? `${hr}h` : `${hr}h${remMin}m`;
}

/**
 * Multi-line live area on stderr. One main line (spinner glyph + bar +
 * counts + ETA + chunk total + label + sub-step suffix), then `workerCount`
 * worker status lines below it. Re-renders on every state change and on a
 * recurring interval so the spinner glyph keeps animating during long
 * operations. Implements `LiveArea` so the logger can clear/redraw the
 * block around stray info/warn lines.
 */
class MultiLineLiveArea implements LiveArea {
	private mainLabel = "";
	private mainSuffix = "";
	private workerLines: string[] = [];
	private total = 0;
	private count = 0;
	private chunks = 0;
	private startedAt = 0;
	private linesWritten = 0;
	private frame = 0;
	private interval: ReturnType<typeof setInterval> | null = null;
	private active = false;
	private color: boolean;

	constructor(color: boolean) {
		this.color = color;
	}

	start(total: number, label: string): void {
		this.total = total;
		this.count = 0;
		this.chunks = 0;
		this.startedAt = Date.now();
		this.mainLabel = label;
		this.mainSuffix = "";
		this.workerLines = [];
		this.linesWritten = 0;
		this.frame = 0;
		this.active = true;
		logger.setActiveLiveArea(this);
		this.render();
		this.interval = setInterval(() => {
			this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
			this.render();
		}, FRAME_INTERVAL_MS);
	}

	tick(label: string): void {
		this.count += 1;
		this.mainLabel = label;
		this.mainSuffix = "";
		this.render();
	}

	setLabel(label: string): void {
		this.mainLabel = label;
		this.render();
	}

	setSuffix(suffix: string): void {
		this.mainSuffix = suffix;
		this.render();
	}

	setWorkerCount(n: number): void {
		this.workerLines = new Array(Math.max(0, n)).fill("");
		this.render();
	}

	setWorker(id: number, line: string): void {
		while (this.workerLines.length <= id) this.workerLines.push("");
		this.workerLines[id] = line;
		this.render();
	}

	addChunks(n: number): void {
		this.chunks += n;
		this.render();
	}

	stop(finalLine: string | undefined, glyphPrefix: string): void {
		if (!this.active) return;
		this.active = false;
		if (this.interval) clearInterval(this.interval);
		this.interval = null;
		this.clear();
		logger.setActiveLiveArea(null);
		if (finalLine) {
			process.stderr.write(`${glyphPrefix}${finalLine}\n`);
		}
	}

	clear(): void {
		if (this.linesWritten === 0) return;
		// Cursor sits at the end of the last rendered line. Walk up, clearing
		// each row, ending at column 0 of the original top line.
		process.stderr.write("\r");
		for (let i = 0; i < this.linesWritten; i++) {
			process.stderr.write("\x1b[2K");
			if (i < this.linesWritten - 1) process.stderr.write("\x1b[1A");
		}
		this.linesWritten = 0;
	}

	render(): void {
		if (!this.active) return;
		this.clear();
		const lines = this.composeLines();
		for (let i = 0; i < lines.length; i++) {
			if (i > 0) process.stderr.write("\n");
			process.stderr.write(lines[i] ?? "");
		}
		this.linesWritten = lines.length;
	}

	private composeLines(): string[] {
		// One column shy of the terminal so the trailing char doesn't trigger
		// a soft wrap on every render — without this, long bar/worker lines
		// occupy two visible rows and `clear()`'s one-up-per-line cursor walk
		// leaves wrap residue, which surfaces as duplicate bars scrolling up
		// the screen as files complete.
		const width = Math.max(20, terminalWidth() - 1);
		const lines: string[] = [clipToWidth(this.composeMainLine(), width)];
		if (this.workerLines.length > 0) {
			// Separator under the bar so the per-worker section reads as a
			// distinct block — without this, the first worker line snugs up
			// against the bar and the bar's tail (label/suffix) bleeds into
			// the worker grid visually.
			lines.push(this.dim("─".repeat(width)));
		}
		for (const w of this.workerLines) {
			const raw = w ? `  ${truncateLabel(w, LABEL_MAX + 20)}` : "";
			lines.push(clipToWidth(raw, width));
		}
		return lines;
	}

	private composeMainLine(): string {
		const glyph = SPINNER_FRAMES[this.frame] ?? "·";
		const bar = renderBar(this.count, this.total);
		const pct = this.total > 0 ? Math.floor((this.count / this.total) * 100) : 0;
		const eta = this.computeEta();
		const stats: string[] = [`${this.count}/${this.total} (${pct}%)`];
		if (this.chunks > 0) stats.push(`${this.chunks} chunks`);
		const elapsedMs = Date.now() - this.startedAt;
		if (elapsedMs > 0) stats.push(`elapsed ${formatDuration(elapsedMs)}`);
		if (eta) stats.push(`ETA ${eta}`);
		const statsStr = this.dim(stats.join(" · "));
		// When per-worker lines are active, the in-flight file/step lives in
		// the worker grid — duplicating it on the bar would just be noise.
		// In single-line mode (workers = 0) we keep the label/suffix tail so
		// short ingests still show what's happening.
		const showTail = this.workerLines.length === 0;
		const labelTail = showTail && this.mainLabel ? ` ${truncateLabel(this.mainLabel)}` : "";
		const suffixTail = showTail && this.mainSuffix ? ` ${this.dim(`— ${this.mainSuffix}`)}` : "";
		return `${glyph} ${bar} ${statsStr}${labelTail}${suffixTail}`;
	}

	/**
	 * Compose the final summary tail appended on `done()` — the per-batch
	 * totals the user asked for: file count, chunk count, elapsed time.
	 * Emitted only when there's something interesting to show (count > 0).
	 */
	totalsSummary(): string {
		if (this.count <= 0) return "";
		const parts = [`${this.count} files`];
		if (this.chunks > 0) parts.push(`${this.chunks} chunks`);
		const elapsedMs = Date.now() - this.startedAt;
		parts.push(`${formatDuration(elapsedMs)} elapsed`);
		return parts.join(" · ");
	}

	private computeEta(): string | null {
		if (this.count <= 0 || this.total <= 0) return null;
		if (this.count >= this.total) return null;
		const elapsed = Date.now() - this.startedAt;
		const remainingMs = (elapsed * (this.total - this.count)) / this.count;
		return formatDuration(remainingMs);
	}

	private dim(text: string): string {
		return this.color ? dim(text) : text;
	}
}

/**
 * Build a `Progress` reporter whose mode is decided once, at call time, from
 * the current TTY state. Use one per multi-entry operation.
 */
export function createProgress(): Progress {
	const interactive = useSpinner();
	const silent = isSilent();

	if (!interactive || silent) {
		return createNonInteractiveProgress(silent);
	}

	const live = new MultiLineLiveArea(useColor());
	let lastSummary: string | undefined;
	let total = 0;
	let count = 0;

	return {
		start(t: number, label?: string) {
			total = t;
			count = 0;
			live.start(t, label ?? "");
		},
		tick(label: string) {
			count += 1;
			live.tick(label);
		},
		setLabel(label: string) {
			live.setLabel(label);
		},
		update(suffix: string) {
			live.setSuffix(suffix);
		},
		setWorkers(n: number) {
			live.setWorkerCount(n);
		},
		workerSet(workerId: number, line: string) {
			live.setWorker(workerId, line);
		},
		addChunks(n: number) {
			live.addChunks(n);
		},
		entry(line: string) {
			logger.info(line);
		},
		done(summary?: string) {
			const base = summary ?? `${count}/${total} done`;
			const totals = live.totalsSummary();
			lastSummary = totals ? `${base} · ${totals}` : base;
			live.stop(lastSummary, useColor() ? `${SPINNER_FRAMES[0]} ` : "✓ ");
		},
		fail(summary?: string) {
			const base = summary ?? `failed at ${count}/${total}`;
			const totals = live.totalsSummary();
			lastSummary = totals ? `${base} · ${totals}` : base;
			live.stop(lastSummary, "✗ ");
		},
		info(msg: string) {
			logger.info(msg);
		},
	};
}

/**
 * Stripped-down progress reporter for non-TTY / silent contexts: emits one
 * line per tick + entry, drops every sub-step / worker / chunk update so CI
 * logs don't blow up.
 */
function createNonInteractiveProgress(silent: boolean): Progress {
	let total = 0;
	let count = 0;
	let chunks = 0;
	let startedAt = 0;
	const totalsTail = (): string => {
		if (count <= 0) return "";
		const parts = [`${count} files`];
		if (chunks > 0) parts.push(`${chunks} chunks`);
		parts.push(`${formatDuration(Date.now() - startedAt)} elapsed`);
		return parts.join(" · ");
	};
	return {
		start(t: number, label?: string) {
			total = t;
			count = 0;
			chunks = 0;
			startedAt = Date.now();
			if (silent) return;
			if (label) logger.info(`${label}: 0/${total}`);
		},
		tick(label: string) {
			count += 1;
			if (silent) return;
			logger.info(`[${count}/${total}] ${label}`);
		},
		setLabel() {},
		update() {},
		setWorkers() {},
		workerSet() {},
		addChunks(n: number) {
			chunks += n;
		},
		entry(line: string) {
			if (silent) return;
			logger.info(line);
		},
		done(summary?: string) {
			if (silent) return;
			const tail = totalsTail();
			const line = summary ? (tail ? `${summary} · ${tail}` : summary) : tail;
			if (line) logger.info(line);
		},
		fail(summary?: string) {
			const tail = totalsTail();
			const line = summary ? (tail ? `${summary} · ${tail}` : summary) : tail;
			if (silent) {
				if (line) logger.warn(line);
				return;
			}
			if (line) logger.warn(line);
		},
		info(msg: string) {
			if (silent) return;
			logger.info(msg);
		},
	};
}
