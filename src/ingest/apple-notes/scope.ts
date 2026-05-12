import picomatch from "picomatch";
import { HelpfulError } from "../../errors.ts";

export const APPLE_NOTES_PREFIX = "apple-notes:";

/**
 * Parsed `apple-notes:[<account>[/<folder-path>]]` scope. The first
 * `/`-segment after the prefix is the account pattern; everything after is
 * the folder-path pattern (forward-slash separated, just like filesystem
 * paths). Empty parts default to match-anything so users can omit them.
 */
export interface AppleNotesScope {
	/** Raw source string, kept for error messages and persistence. */
	raw: string;
	/** Picomatch-compatible glob against the account display name (e.g. `iCloud`, `Personal`). */
	accountPattern: string;
	/** Picomatch-compatible glob against the folder path (e.g. `Work/Meetings`). */
	folderPattern: string;
}

/**
 * Parse `apple-notes:` source args into matcher patterns. Splits on the
 * first `/` after the prefix; empty/missing parts become permissive
 * wildcards. `apple-notes:` alone matches everything.
 */
export function parseAppleNotesScope(source: string): AppleNotesScope {
	if (!source.startsWith(APPLE_NOTES_PREFIX)) {
		throw new HelpfulError({
			kind: "input_error",
			message: `not an Apple Notes scope: ${source}`,
			hint: `Use a source like \`apple-notes:\` or \`apple-notes:Personal/Recipes\`.`,
		});
	}
	const body = source.slice(APPLE_NOTES_PREFIX.length).trim();
	if (body === "") {
		return { raw: source, accountPattern: "*", folderPattern: "**" };
	}
	const slash = body.indexOf("/");
	if (slash === -1) {
		return { raw: source, accountPattern: body, folderPattern: "**" };
	}
	const accountPart = body.slice(0, slash);
	let folderPart = body.slice(slash + 1);
	// Trailing slash → "any folder under that prefix" rather than the
	// useless empty-string match. Mirrors how filesystem `dir/` is read.
	if (folderPart === "" || folderPart === "/") {
		folderPart = "**";
	}
	return {
		raw: source,
		accountPattern: accountPart === "" ? "*" : accountPart,
		folderPattern: folderPart,
	};
}

/**
 * Compile the matchers for a scope. Returned predicates accept literal
 * account names and folder paths (no escaping required at the call site).
 */
export function compileScopeMatchers(scope: AppleNotesScope): {
	matchAccount: (accountName: string) => boolean;
	matchFolder: (folderPath: string) => boolean;
} {
	const accountMatch = picomatch(scope.accountPattern, { dot: false, nocase: false });
	const folderMatch = picomatch(scope.folderPattern, { dot: false, nocase: false });
	return {
		matchAccount: (name) => accountMatch(name),
		matchFolder: (path) => folderMatch(path),
	};
}
