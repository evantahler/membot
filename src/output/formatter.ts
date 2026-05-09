import ansis, { bold, cyan, dim, green, red, yellow } from "ansis";
import { isJson, useColor } from "./tty.ts";

function colorize(fn: (s: string) => string, msg: string): string {
	return useColor() ? fn(msg) : msg;
}

/**
 * Render a final result for the CLI. JSON mode → JSON.stringify. Otherwise
 * defer to the optional `console_formatter`, falling back to JSON.
 */
export function renderResult<T>(result: T, opts: { console_formatter?: (result: T) => string } = {}): string {
	if (isJson()) {
		return JSON.stringify(result, null, 2);
	}
	if (opts.console_formatter) return opts.console_formatter(result);
	if (typeof result === "string") return result;
	return JSON.stringify(result, null, 2);
}

/**
 * Format a byte count as a short human-readable string: 5654 → `5.5 KB`,
 * 14_859 → `14.5 KB`, 2_345_678 → `2.2 MB`. Uses 1024-based units (binary
 * prefixes) since file sizes on disk are typically reported that way.
 * Negative or non-finite inputs render as `0 B`.
 */
export function formatBytes(n: number): string {
	if (!Number.isFinite(n) || n < 0) return "0 B";
	if (n < 1024) return `${n} B`;
	const units = ["KB", "MB", "GB", "TB"] as const;
	let value = n / 1024;
	let unit: string = units[0];
	for (let i = 1; i < units.length && value >= 1024; i++) {
		value /= 1024;
		unit = units[i] as string;
	}
	// One decimal until 100, then round to integer (so the column stays narrow).
	const formatted = value < 100 ? value.toFixed(1) : `${Math.round(value)}`;
	return `${formatted} ${unit}`;
}

/**
 * Pretty-print a 2D array of cells as an aligned table. Column widths are
 * computed from the visible (escape-stripped) length of each cell so coloured
 * cells still align. Optional `columnStyles` are applied AFTER padding so they
 * don't perturb width math.
 */
export function renderTable(
	headers: string[],
	rows: string[][],
	opts: { columnStyles?: (((s: string) => string) | undefined)[] } = {},
): string {
	const widths = headers.map((h, i) => Math.max(visibleLen(h), ...rows.map((r) => visibleLen(r[i] ?? ""))));
	const styles = opts.columnStyles ?? [];

	const headerLine = headers.map((h, i) => pad(h, widths[i] ?? 0)).join("  ");
	const separator = headers.map((_, i) => "─".repeat(widths[i] ?? 0)).join("  ");
	const bodyLines = rows.map((r) =>
		r
			.map((cell, i) => {
				const padded = pad(cell ?? "", widths[i] ?? 0);
				const style = styles[i];
				return style ? style(padded) : padded;
			})
			.join("  "),
	);

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
