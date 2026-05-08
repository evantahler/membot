export type ErrorKind =
	| "input_error"
	| "not_found"
	| "conflict"
	| "auth_error"
	| "network_error"
	| "unsupported_mime"
	| "partial_failure"
	| "internal_error";

export interface HelpfulErrorArgs {
	kind: ErrorKind;
	message: string;
	hint: string;
	details?: unknown;
	cause?: unknown;
}

/**
 * The only error type allowed inside membot handlers. The mount adapters
 * (commander + MCP) catch this and render `kind` + `message` + `hint`
 * for both surfaces.
 */
export class HelpfulError extends Error {
	readonly kind: ErrorKind;
	readonly hint: string;
	readonly details?: unknown;
	override readonly cause?: unknown;

	constructor(args: HelpfulErrorArgs) {
		super(args.message);
		if (!args.hint?.trim()) {
			throw new Error("HelpfulError requires a non-empty hint");
		}
		this.name = "HelpfulError";
		this.kind = args.kind;
		this.hint = args.hint;
		this.details = args.details;
		this.cause = args.cause;
	}
}

export function isHelpfulError(e: unknown): e is HelpfulError {
	return e instanceof HelpfulError;
}

/**
 * Wrap an unknown error so callers can:
 *   try { ... } catch (e) { throw asHelpful(e, "while reading PDF", "Try ...", "internal_error") }
 */
export function asHelpful(
	cause: unknown,
	context: string,
	hint: string,
	kind: ErrorKind = "internal_error",
): HelpfulError {
	if (cause instanceof HelpfulError) return cause;
	const msg = cause instanceof Error ? cause.message : String(cause);
	return new HelpfulError({
		kind,
		message: `${context}: ${msg}`,
		hint,
		cause,
	});
}

/** Map an ErrorKind to a stable process exit code. */
export function mapKindToExit(kind: ErrorKind): number {
	switch (kind) {
		case "input_error":
			return 2;
		case "not_found":
			return 3;
		case "conflict":
			return 4;
		case "auth_error":
			return 5;
		case "network_error":
			return 6;
		case "unsupported_mime":
			return 7;
		case "partial_failure":
			return 8;
		default:
			return 1;
	}
}
