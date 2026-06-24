import type { ProgressInfo } from "@huggingface/transformers";
import { formatBytes } from "./formatter.ts";
import { logger, type Spinner } from "./logger.ts";
import { renderBar } from "./progress.ts";

/**
 * A reporter that turns `@huggingface/transformers` model-load progress events
 * into a single-line stderr progress bar — shown only when an actual network
 * download happens (first run / cold cache), and silent on a warm cache.
 *
 * `onProgress` is the function handed to transformers as `progress_callback`;
 * `finish()` is called once the load resolves (in a `finally`) to close the
 * bar. Both are no-ops in JSON / piped / CI / silent modes because the
 * underlying `logger.startSpinner` returns a no-op spinner there — the only
 * non-interactive signal is one suppressible `info` line on download start.
 */
export interface ModelDownloadReporter {
	/** Feed one transformers progress event. Lazily starts the bar on the first real download event. */
	onProgress: (info: ProgressInfo) => void;
	/** Close the bar with a success line. No-op if no download ever started. */
	finish: () => void;
}

/** Re-render no more often than this, unless the percentage changed. */
const RENDER_THROTTLE_MS = 150;

/**
 * Build a model-download progress reporter for one model load. `label` is the
 * human role of the model ("embedding", "reranker"); `model` is the HF id.
 *
 * The bar starts lazily: transformers fires `initiate`/`done` events even for a
 * pure cache hit, but only emits `download` / `progress` (with byte totals) /
 * `progress_total` when it actually fetches from the network. We start the bar
 * on the first of those, so a warm cache renders nothing at all.
 */
export function createModelDownloadReporter(label: string, model: string): ModelDownloadReporter {
	let spinner: Spinner | null = null;
	let started = false;
	// Per-file byte progress from `progress` events, keyed by file name.
	const files = new Map<string, { loaded: number; total: number }>();
	// Aggregate from a `progress_total` event, when transformers provides one
	// (smoother than summing the per-file map, which grows as files start).
	let totalAgg: { loaded: number; total: number } | null = null;
	let lastPct = -1;
	let lastRenderAt = 0;

	/** Current (loaded, total) bytes — prefer the aggregate event, else sum per-file. */
	const aggregate = (): { loaded: number; total: number } => {
		if (totalAgg) return totalAgg;
		let loaded = 0;
		let total = 0;
		for (const f of files.values()) {
			loaded += f.loaded;
			total += f.total;
		}
		return { loaded, total };
	};

	/** Start the spinner + emit the one non-interactive info line. Idempotent. */
	const begin = (): void => {
		if (started) return;
		started = true;
		logger.info(`Downloading ${label} model ${model} (first run, this may take a moment)…`);
		spinner = logger.startSpinner(`Downloading ${label} model ${model}…`);
	};

	/** Repaint the bar, throttled so per-chunk events don't thrash the terminal. */
	const render = (): void => {
		if (!spinner) return;
		const { loaded, total } = aggregate();
		if (total <= 0) return;
		const pct = Math.min(100, Math.floor((loaded / total) * 100));
		const now = Date.now();
		if (pct === lastPct && now - lastRenderAt < RENDER_THROTTLE_MS) return;
		lastPct = pct;
		lastRenderAt = now;
		spinner.update(
			`Downloading ${label} model ${model}  ${renderBar(loaded, total)} ${pct}%  ${formatBytes(loaded)}/${formatBytes(total)}`,
		);
	};

	return {
		onProgress(info: ProgressInfo): void {
			switch (info.status) {
				case "download":
					begin();
					break;
				case "progress":
					files.set(info.file, { loaded: info.loaded ?? 0, total: info.total ?? 0 });
					if ((info.total ?? 0) > 0) {
						begin();
						render();
					}
					break;
				case "progress_total":
					totalAgg = { loaded: info.loaded ?? 0, total: info.total ?? 0 };
					if (totalAgg.total > 0) {
						begin();
						render();
					}
					break;
				// "initiate", "done", "ready" carry no byte info — ignored. A cache
				// hit only ever fires these, so the bar never starts.
			}
		},
		finish(): void {
			if (!started || !spinner) return;
			const { total } = aggregate();
			spinner.success(`Downloaded ${label} model${total > 0 ? ` (${formatBytes(total)})` : ""}`);
			spinner = null;
		},
	};
}
