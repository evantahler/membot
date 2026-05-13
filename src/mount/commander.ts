import type { Command } from "commander";
import type { z } from "zod";
import { type AppContext, type BuildContextOptions, buildContext, closeContext } from "../context.ts";
import { asHelpful, HelpfulError, isHelpfulError, mapKindToExit } from "../errors.ts";
import { composeDescription, defaultCliName, type Operation } from "../operations/types.ts";
import { colors, renderResult } from "../output/formatter.ts";
import { logger } from "../output/logger.ts";
import { isJson } from "../output/tty.ts";
import { applySchemaToCommand, toKebab } from "./zod-to-cli.ts";

/**
 * Mount an Operation as a commander subcommand. The command:
 *   1. accepts positional + flag args inferred from the zod input schema
 *   2. validates with the same schema
 *   3. starts a spinner, runs the handler, prints the formatted result
 *   4. catches `HelpfulError` and renders it (color text on stderr for a TTY, JSON on stdout in --json mode)
 */
export function mountAsCommanderCommand<I extends z.ZodObject, O extends z.ZodTypeAny>(
	program: Command,
	op: Operation<I, O>,
	getContextOptions: () => BuildContextOptions,
): void {
	const cmdName = defaultCliName(op);
	const cmd = program.command(cmdName).description(composeDescription(op));

	applySchemaToCommand(cmd, op.inputSchema, {
		positional: (op.cli?.positional as readonly string[] | undefined) ?? [],
		aliases: op.cli?.aliases as Readonly<Record<string, string>> | undefined,
	});

	cmd.action(async (...args: unknown[]) => {
		// Commander passes positionals first, then the options object, then the Command instance.
		// The middle option-bag is what we want for flag values.
		let optsObj: Record<string, unknown> = {};
		for (const a of args) {
			if (a && typeof a === "object" && !Array.isArray(a) && a.constructor && a.constructor.name === "Object") {
				optsObj = a as Record<string, unknown>;
			}
		}
		const positionals = args.slice(0, op.cli?.positional?.length ?? 0);

		const inputObj: Record<string, unknown> = {};

		const positionalNames = (op.cli?.positional ?? []) as readonly string[];
		positionalNames.forEach((name, i) => {
			if (positionals[i] !== undefined) inputObj[name] = positionals[i];
		});

		for (const fieldName of Object.keys(op.inputSchema.shape)) {
			if (positionalNames.includes(fieldName)) continue;
			const camel = kebabToCamel(toKebab(fieldName));
			const v = optsObj[camel] ?? optsObj[fieldName];
			if (v !== undefined) inputObj[fieldName] = v;
		}

		// stdinField support: read stdin when the field is missing AND stdin is not a TTY.
		if (op.cli?.stdinField && inputObj[op.cli.stdinField as string] === undefined && !process.stdin.isTTY) {
			const stdin = await readStdin();
			if (stdin.length > 0) inputObj[op.cli.stdinField as string] = stdin;
		}

		let ctx: AppContext | null = null;
		try {
			const parsedInput = parseInput(op, inputObj);
			ctx = await buildContext(getContextOptions());
			const result = await op.handler(parsedInput, ctx);
			const validated = parseOutput(op, result);
			process.stdout.write(
				`${renderResult(validated, { console_formatter: op.console_formatter, input: parsedInput })}\n`,
			);
		} catch (err) {
			renderCliError(err);
			const exitCode = isHelpfulError(err) ? mapKindToExit(err.kind) : 1;
			if (ctx) await closeContext(ctx);
			process.exit(exitCode);
		}
		if (ctx) await closeContext(ctx);
	});
}

/** Validate the user-supplied input against the operation's zod schema. */
function parseInput<I extends z.ZodObject, O extends z.ZodTypeAny>(
	op: Operation<I, O>,
	inputObj: Record<string, unknown>,
): z.infer<I> {
	const result = op.inputSchema.safeParse(inputObj);
	if (!result.success) {
		throw new HelpfulError({
			kind: "input_error",
			message: `invalid arguments to ${op.name}: ${result.error.message}`,
			hint: `Run \`membot ${defaultCliName(op)} --help\` to see expected arguments.`,
			details: result.error.issues,
		});
	}
	return result.data;
}

/** Validate the handler's return value against the operation's output schema. */
function parseOutput<I extends z.ZodObject, O extends z.ZodTypeAny>(op: Operation<I, O>, result: unknown): z.infer<O> {
	const validated = op.outputSchema.safeParse(result);
	if (!validated.success) {
		throw new HelpfulError({
			kind: "internal_error",
			message: `${op.name} produced an output that doesn't match its declared schema: ${validated.error.message}`,
			hint: "This is a membot bug. Re-run with --verbose and report at https://github.com/evantahler/membot/issues.",
			details: validated.error.issues,
			cause: validated.error,
		});
	}
	return validated.data;
}

/**
 * Render an error caught at the mount boundary. Wraps unknown errors via
 * `asHelpful()` so the output shape (kind/message/hint) is uniform regardless
 * of where the throw came from. In `--json` mode the structured payload goes
 * to stdout (same stream as successful results); in human mode it goes to
 * stderr alongside other log output.
 */
export function renderCliError(err: unknown): void {
	const helpful = isHelpfulError(err)
		? err
		: asHelpful(
				err,
				"unexpected error",
				"Re-run with --verbose for the underlying message; if it persists this is a bug.",
				"internal_error",
			);

	if (isJson()) {
		const payload = {
			ok: false,
			error: {
				kind: helpful.kind,
				message: helpful.message,
				hint: helpful.hint,
				details: helpful.details,
			},
		};
		process.stdout.write(`${JSON.stringify(payload)}\n`);
		return;
	}

	logger.error(`✗ ${helpful.message}`);
	logger.writeRaw(`  ${colors.yellow("hint:")} ${helpful.hint}\n`);
	if (helpful.details !== undefined) {
		logger.writeRaw(`  ${colors.dim(`details: ${formatDetails(helpful.details)}`)}\n`);
	}
}

function formatDetails(details: unknown): string {
	try {
		return JSON.stringify(details);
	} catch {
		return String(details);
	}
}

/** kebab-case-or-snake_case → camelCase (commander gives us camelCase keys on opts). */
function kebabToCamel(s: string): string {
	return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

/** Drain stdin into a single string. Used by operations whose `cli.stdinField` is unset. */
async function readStdin(): Promise<string> {
	const chunks: Uint8Array[] = [];
	for await (const chunk of process.stdin as AsyncIterable<Uint8Array>) {
		chunks.push(chunk);
	}
	const total = chunks.reduce((n, c) => n + c.byteLength, 0);
	const merged = new Uint8Array(total);
	let offset = 0;
	for (const c of chunks) {
		merged.set(c, offset);
		offset += c.byteLength;
	}
	return new TextDecoder().decode(merged);
}
