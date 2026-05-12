import { DatabaseAccessDeniedError, DatabaseNotFoundError, PasswordProtectedError } from "macos-ts";
import { HelpfulError, isHelpfulError } from "../../errors.ts";

/**
 * Throw a HelpfulError unless we're on macOS. Apple Notes lives in a
 * NoteStore.sqlite under `~/Library/Group Containers/` — there is no
 * equivalent on Linux or Windows.
 */
export function assertAppleNotesPlatform(): void {
	if (process.platform !== "darwin") {
		throw new HelpfulError({
			kind: "input_error",
			message: "Apple Notes import requires macOS",
			hint: `Run \`membot add apple-notes:...\` on a Mac with the Notes app installed. Detected platform: ${process.platform}.`,
		});
	}
}

/**
 * Translate macos-ts errors into HelpfulError so the mount adapters can
 * render them consistently. Anything not recognized is rethrown untouched
 * so callers can layer their own context with `asHelpful`.
 */
export function mapAppleNotesError(err: unknown): HelpfulError {
	if (isHelpfulError(err)) return err;
	if (err instanceof DatabaseAccessDeniedError) {
		return new HelpfulError({
			kind: "auth_error",
			message: "Cannot read the Apple Notes database — Full Disk Access required",
			hint: "Grant Full Disk Access in System Settings → Privacy & Security → Full Disk Access for your terminal/editor (Terminal, iTerm, Warp, Cursor, VSCode, etc.), then re-run. Run `open 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'` to jump straight to the pane.",
			cause: err,
		});
	}
	if (err instanceof DatabaseNotFoundError) {
		return new HelpfulError({
			kind: "not_found",
			message: "Apple Notes database not found",
			hint: "Open the Notes app at least once on this Mac so macOS provisions the local NoteStore.sqlite, then re-run.",
			cause: err,
		});
	}
	if (err instanceof PasswordProtectedError) {
		return new HelpfulError({
			kind: "auth_error",
			message: "Note is password-protected — skipping",
			hint: "Unlock the note in Notes.app and re-ingest, or pass a scope that excludes locked notes.",
			cause: err,
		});
	}
	const message = err instanceof Error ? err.message : String(err);
	return new HelpfulError({
		kind: "internal_error",
		message: `Apple Notes access failed: ${message}`,
		hint: "Run with `--verbose` to see the underlying macos-ts error, or open an issue at https://github.com/evantahler/membot/issues.",
		cause: err,
	});
}

/** Re-export for downstream callers that need to detect locked notes individually. */
export { PasswordProtectedError };
