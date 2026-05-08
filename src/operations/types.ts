import type { z } from "zod";
import type { AppContext } from "../context.ts";

/**
 * One user-facing capability defined ONCE: an MCP tool registration AND a
 * commander CLI subcommand. Both surfaces consume `description`, `inputSchema`,
 * and the handler from the same value, so help text and argument parsing
 * cannot drift apart.
 */
export interface Operation<I extends z.ZodObject = z.ZodObject, O extends z.ZodTypeAny = z.ZodTypeAny> {
	/** MCP tool name. Convention: `membot_<verb>` (e.g. "membot_add"). */
	name: string;
	/** CLI subcommand name. Defaults to `name.replace(/^membot_/, "").replaceAll("_", "-")`. */
	cliName?: string;
	/**
	 * Optional bash-equivalent label (e.g. `cat`, `grep -r`). Surfaced as
	 * `[[ bash equivalent: <value> ]]` by the description composer when the
	 * mount adapter wants the prefix. Stored separately from `description`
	 * so callers can render with or without the prefix as they choose.
	 */
	bashEquivalent?: string;
	/**
	 * Pure prose description string. Shown to the LLM in `tools/list` AND to
	 * humans via `--help` (the mount adapter prepends `bashEquivalent` when
	 * present). Should follow purpose → when-to-use → recovery-hint shape.
	 */
	description: string;
	/** Single source of truth for the input contract. */
	inputSchema: I;
	/** Output contract — validated before being returned to the caller. */
	outputSchema: O;
	/** CLI-only metadata (positional args, short flag aliases, stdin source). */
	cli?: CliMetadata<I>;
	/**
	 * Optional console formatter. Called by the commander mount adapter when
	 * stdout is a TTY (and not in `--json` mode) to render the operation's
	 * output as colorized human text. The MCP surface ignores this — agents
	 * always receive the structured `outputSchema` data. When unset, the CLI
	 * falls back to pretty-printed JSON.
	 */
	console_formatter?: (result: z.infer<O>) => string;
	/** The work itself. AppContext gives access to db, embedder, mcpx, logger, config. */
	handler: (input: z.infer<I>, ctx: AppContext) => Promise<z.infer<O>>;
}

/** CLI-only knobs for an Operation: positional args, short-flag aliases, stdin sourcing. */
export interface CliMetadata<I extends z.ZodObject> {
	/** Field names that should become positional arguments instead of flags. */
	positional?: (keyof z.infer<I>)[];
	/** Short-flag aliases keyed by field name (e.g. `{ logical_path: "-p" }`). */
	aliases?: Partial<Record<keyof z.infer<I>, string>>;
	/** Field name that should be filled from stdin when not otherwise supplied. */
	stdinField?: keyof z.infer<I>;
}

/** Helper that infers the generic params and lets call sites stay terse. */
export function defineOperation<I extends z.ZodObject, O extends z.ZodTypeAny>(op: Operation<I, O>): Operation<I, O> {
	return op;
}

/**
 * Default CLI command name for an Operation. Strips the `membot_` prefix and
 * converts underscores to dashes. Override via `op.cliName`.
 */
export function defaultCliName(op: { name: string; cliName?: string }): string {
	if (op.cliName) return op.cliName;
	return op.name.replace(/^membot_/, "").replaceAll("_", "-");
}

/**
 * Compose the surface-rendered description: `[[ bash equivalent: X ]] <desc>`
 * when `bashEquivalent` is set, otherwise the raw `description`. Used by both
 * the MCP and commander mount adapters so the same string lands in front of
 * agents (`tools/list`) and humans (`--help`).
 */
export function composeDescription(op: { description: string; bashEquivalent?: string }): string {
	if (op.bashEquivalent && op.bashEquivalent.trim()) {
		return `[[ bash equivalent: ${op.bashEquivalent.trim()} ]] ${op.description}`;
	}
	return op.description;
}
