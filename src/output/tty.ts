/**
 * Single source of truth for whether the CLI is running interactively. All
 * spinner / color / progress decisions go through these helpers — operations
 * never inspect process.stdout themselves.
 *
 * Mode resolution (read once at startup, then frozen via setMode):
 *   stdout.isTTY && stderr.isTTY && !json   → interactive
 *   anything else                            → non-interactive
 *   CI=true                                  → forces non-interactive
 *   --no-color or NO_COLOR                   → disables ANSI even if interactive
 *   FORCE_COLOR                              → forces ANSI on regardless
 */

export interface OutputMode {
	interactive: boolean;
	color: boolean;
	json: boolean;
	verbose: boolean;
}

let mode: OutputMode | null = null;

export interface DetectModeOptions {
	json?: boolean;
	noColor?: boolean;
	forceColor?: boolean;
	verbose?: boolean;
}

/** Compute the active output mode from env + flags. Idempotent. */
export function detectMode(opts: DetectModeOptions = {}): OutputMode {
	const json = !!opts.json;
	const verbose = !!opts.verbose;
	const stdoutTty = !!(process.stdout.isTTY ?? false);
	const stderrTty = !!(process.stderr.isTTY ?? false);
	const ci = process.env.CI === "true" || process.env.CI === "1";

	const interactive = !json && !ci && stdoutTty && stderrTty;

	const noColorEnv = !!process.env.NO_COLOR;
	const forceColor = !!opts.forceColor || !!process.env.FORCE_COLOR;
	const noColorFlag = !!opts.noColor;

	let color: boolean;
	if (forceColor) color = true;
	else if (noColorFlag || noColorEnv || json) color = false;
	else color = stderrTty; // colors target stderr (logs) and stdout (formatted output)

	return { interactive, color, json, verbose };
}

export function setMode(m: OutputMode): void {
	mode = m;
}

export function getMode(): OutputMode {
	if (!mode) mode = detectMode();
	return mode;
}

export function isInteractive(): boolean {
	return getMode().interactive;
}

export function useColor(): boolean {
	return getMode().color;
}

export function useSpinner(): boolean {
	return getMode().interactive && !getMode().verbose;
}

export function isJson(): boolean {
	return getMode().json;
}

export function isVerbose(): boolean {
	return getMode().verbose;
}
