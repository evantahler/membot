import ansis, { bold, cyan, dim, green, red, yellow } from "ansis";
import { isJson, useColor } from "./tty.ts";

function colorize(fn: (s: string) => string, msg: string): string {
	return useColor() ? fn(msg) : msg;
}

/**
 * Render a final result for the CLI. JSON mode → JSON.stringify. Otherwise
 * defer to the optional `human` rendering, falling back to JSON.
 */
export function renderResult(result: unknown, opts: { human?: (result: unknown) => string } = {}): string {
	if (isJson()) {
		return JSON.stringify(result, null, 2);
	}
	if (opts.human) return opts.human(result);
	if (typeof result === "string") return result;
	return JSON.stringify(result, null, 2);
}

/** Pretty-print a 2D array of cells as an aligned table. Truncates wide rows. */
export function renderTable(headers: string[], rows: string[][]): string {
	const widths = headers.map((h, i) => Math.max(visibleLen(h), ...rows.map((r) => visibleLen(r[i] ?? ""))));

	const headerLine = headers.map((h, i) => pad(h, widths[i] ?? 0)).join("  ");
	const separator = headers.map((_, i) => "─".repeat(widths[i] ?? 0)).join("  ");
	const bodyLines = rows.map((r) => r.map((cell, i) => pad(cell ?? "", widths[i] ?? 0)).join("  "));

	const out = [colorize(bold, headerLine), colorize(dim, separator), ...bodyLines];
	return out.join("\n");
}

function visibleLen(s: string): number {
	return ansis.strip(s).length;
}

function pad(s: string, width: number): string {
	const visible = visibleLen(s);
	if (visible >= width) return s;
	return s + " ".repeat(width - visible);
}

export const colors = {
	bold: (s: string) => colorize(bold, s),
	dim: (s: string) => colorize(dim, s),
	red: (s: string) => colorize(red, s),
	green: (s: string) => colorize(green, s),
	yellow: (s: string) => colorize(yellow, s),
	cyan: (s: string) => colorize(cyan, s),
};
