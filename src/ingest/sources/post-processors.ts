import TurndownService from "turndown";
import {
	BUILTIN_POST_PROCESSORS,
	type BuiltinPostProcessor,
	type PostProcessSpec,
} from "../../config/router-validation.ts";
import { asHelpful, HelpfulError } from "../../errors.ts";

/**
 * Apply a `post_process` spec to the raw bytes returned by a router's
 * primary command. Built-in names route to a small fixed set of transforms;
 * a `{command, args}` spec spawns a second shell command and pipes the
 * bytes through its stdin → stdout.
 *
 * The `vars` map is the named-capture-group output from the router's
 * url_pattern, used for `{var}` substitution in the post-process shell
 * command's argv. The primary fetch already substituted these into its
 * own argv before invocation — we re-substitute here so post-processors
 * have access to the same identifiers (handy when, say, piping through
 * a script that wants the doc id as a flag).
 */
export async function applyPostProcessor(
	spec: PostProcessSpec,
	bytes: Uint8Array,
	vars: Record<string, string>,
	url: string,
): Promise<Uint8Array> {
	if (typeof spec === "string") {
		return applyBuiltin(spec, bytes);
	}
	return await applyShell(spec.command, spec.args, spec.timeout_ms, bytes, vars, url);
}

function applyBuiltin(name: BuiltinPostProcessor, bytes: Uint8Array): Uint8Array {
	switch (name) {
		case "passthrough":
			return bytes;
		case "docmd":
			return new TextEncoder().encode(normalizeDocmd(new TextDecoder().decode(bytes)));
		case "html-to-markdown":
			return new TextEncoder().encode(htmlToMarkdown(new TextDecoder().decode(bytes)));
		default: {
			const _exhaustive: never = name;
			throw new HelpfulError({
				kind: "input_error",
				message: `unknown built-in post_process: ${String(_exhaustive)}`,
				hint: `Pick one of: ${BUILTIN_POST_PROCESSORS.join(", ")}, or supply a {command, args} object.`,
			});
		}
	}
}

const turndown = new TurndownService({
	headingStyle: "atx",
	codeBlockStyle: "fenced",
	bulletListMarker: "-",
});

/** Render HTML bytes to markdown via the same Turndown config the html converter uses. */
function htmlToMarkdown(html: string): string {
	const cleaned = html
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<noscript[\s\S]*?<\/noscript>/gi, "");
	return turndown.turndown(cleaned).trim();
}

/**
 * Light cleanup for Google's "docmd" export — the mcpx Google Docs tool
 * returns text that's already mostly markdown, but with a few quirks worth
 * smoothing over before it flows into chunking + embedding:
 *  - non-breaking spaces (U+00A0) are common in pasted-from-Docs text; we
 *    replace them with normal spaces so the tokenizer doesn't treat them
 *    as a different word boundary class.
 *  - smart quotes are normalized to ASCII so search queries with straight
 *    quotes still match.
 *  - trailing whitespace on each line is dropped (markdown's two-spaces
 *    hard-break is preserved if it predates other trailing whitespace,
 *    which it shouldn't in docmd output but the rule is conservative).
 *  - CRLF -> LF, and runs of 3+ blank lines collapse to 2.
 * If your docmd output needs heavier transformation, use a custom shell
 * post-processor (e.g. pipe through pandoc) — that path is open by design.
 */
export function normalizeDocmd(raw: string): string {
	const decoded = raw.replace(/\r\n?/g, "\n").replace(/ /g, " ");
	const dequoted = decoded
		.replace(/[‘’‚‛]/g, "'")
		.replace(/[“”„‟]/g, '"')
		.replace(/[–—]/g, "-");
	const trimmedLines = dequoted
		.split("\n")
		.map((line) => line.replace(/[ \t]+$/, ""))
		.join("\n");
	const collapsedBlank = trimmedLines.replace(/\n{3,}/g, "\n\n");
	return collapsedBlank.trim();
}

/**
 * Spawn a shell command (argv-style — no shell, no interpolation) and pipe
 * `bytes` through its stdin. Stdout becomes the post-processed bytes;
 * non-zero exit or timeout throws `HelpfulError` with the stderr tail.
 */
async function applyShell(
	command: string,
	argTemplates: readonly string[],
	timeoutMs: number,
	bytes: Uint8Array,
	vars: Record<string, string>,
	url: string,
): Promise<Uint8Array> {
	const args = argTemplates.map((arg) => substituteVars(arg, vars, url));
	let proc: ReturnType<typeof Bun.spawn>;
	try {
		proc = Bun.spawn({
			cmd: [command, ...args],
			stdin: bytes,
			stdout: "pipe",
			stderr: "pipe",
		});
	} catch (err) {
		throw asHelpful(
			err,
			`while spawning post_process command "${command}"`,
			`Verify the command is on PATH: \`which ${command}\`. Update the router with \`membot router add\`.`,
			"input_error",
		);
	}

	const killTimer = setTimeout(() => {
		try {
			proc.kill("SIGKILL");
		} catch {
			// best-effort
		}
	}, timeoutMs);

	let exitCode: number;
	let stdout: ArrayBuffer;
	let stderr: ArrayBuffer;
	try {
		[exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout as ReadableStream).arrayBuffer(),
			new Response(proc.stderr as ReadableStream).arrayBuffer(),
		]);
	} finally {
		clearTimeout(killTimer);
	}

	if (exitCode !== 0) {
		const stderrText = new TextDecoder().decode(stderr).trim().slice(-500);
		throw new HelpfulError({
			kind: "network_error",
			message: `post_process command "${command}" exited ${exitCode}${stderrText ? `: ${stderrText}` : ""}`,
			hint: `Run \`${command} ${args.join(" ")}\` manually to reproduce. Update the router with \`membot router add\` if the command changed.`,
		});
	}

	return new Uint8Array(stdout);
}

/**
 * Replace every `{name}` token in `template` with `vars[name]`. The
 * special token `{url}` resolves to the full source URL. Missing names
 * throw HelpfulError — config-load validation already prevented this for
 * router-declared placeholders, so an unrecognized name here means
 * either a programmer bug or a manually-edited config.json that
 * bypassed validation.
 */
export function substituteVars(template: string, vars: Record<string, string>, url: string): string {
	return template.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (_match, name: string) => {
		if (name === "url") return url;
		const value = vars[name];
		if (value === undefined) {
			throw new HelpfulError({
				kind: "input_error",
				message: `router placeholder {${name}} has no value`,
				hint: `Add a named capture group "(?<${name}>...)" to the router's url_pattern, or remove {${name}} from args/stdin via \`membot router add\`.`,
			});
		}
		return value;
	});
}
