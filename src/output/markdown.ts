import matter from "gray-matter";
import { colors } from "./formatter.ts";
import { isInteractive, useColor } from "./tty.ts";

/**
 * Render a markdown string for display in a rich terminal: parse any
 * YAML frontmatter into a colorized key/value block at the top, then run
 * the body through `Bun.markdown.ansi` for headings, emphasis, code,
 * lists, links, and blockquote styling. Falls back to the raw text when
 * the active output mode is not a colored interactive TTY (piped output,
 * `--no-color`, `--json`, `--raw`, CI).
 *
 * This is the only call site for `Bun.markdown.ansi` — everything else
 * should go through `renderForTty` so the TTY mode check is centralized.
 */
export function renderMarkdownAnsi(text: string): string {
	const parsed = matter(text);
	const body = Bun.markdown.ansi(parsed.content);
	if (Object.keys(parsed.data).length === 0) return body;
	const header = renderFrontmatterAnsi(parsed.data);
	return `${header}\n\n${body}`;
}

/**
 * Choose between `renderMarkdownAnsi` and the raw text. `raw=true` is the
 * explicit CLI opt-out (`membot read --raw`); the mode check handles the
 * implicit cases (piped output, NO_COLOR, CI, --json).
 */
export function renderForTty(text: string, raw: boolean): string {
	if (raw) return text;
	if (!useColor() || !isInteractive()) return text;
	return renderMarkdownAnsi(text);
}

/**
 * Render a frontmatter data object as a compact ANSI block: each key in
 * dim cyan, value in default colour, arrays joined with ", ". Multi-line
 * scalar values keep their newlines but get indented under the key.
 */
function renderFrontmatterAnsi(data: Record<string, unknown>): string {
	const lines: string[] = [];
	for (const [key, value] of Object.entries(data)) {
		lines.push(`${colors.cyan(`${key}:`)} ${formatScalar(value)}`);
	}
	return lines.join("\n");
}

/**
 * Stringify a single frontmatter value for the dim-key header. Arrays
 * render as comma-joined scalars; objects fall back to JSON; primitives
 * are stringified as-is.
 */
function formatScalar(value: unknown): string {
	if (value === null || value === undefined) return colors.dim("∅");
	if (Array.isArray(value)) return value.map((v) => String(v)).join(", ");
	if (typeof value === "object") return JSON.stringify(value);
	return String(value);
}
