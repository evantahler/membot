import { DatabaseAccessDeniedError, DatabaseNotFoundError, PasswordProtectedError } from "macos-ts";
import { HelpfulError, isHelpfulError } from "../../errors.ts";

/** A macOS `.app` bundle resolved from an executable path. */
export interface AppBundle {
	/** Absolute path to the bundle, e.g. `/Applications/Conductor.app`. */
	path: string;
	/** Bundle display name without the `.app` suffix, e.g. `Conductor`. */
	name: string;
}

/**
 * Extract the `.app` bundle from an executable path. macOS buries the real
 * binary deep inside the bundle (`Foo.app/Contents/MacOS/foo`), so we want
 * the path truncated at the first `.app` segment. Returns the *outer-most*
 * bundle when nested (e.g. a path through `Foo.app/.../Bar Helper.app/...`
 * resolves to `Foo.app`, the bundle macOS attributes responsibility to).
 * Returns `null` when the path contains no `.app` segment.
 */
export function appBundleFromPath(execPath: string): AppBundle | null {
	if (!execPath) return null;
	const match = execPath.match(/^(.*?\/([^/]+)\.app)(?:\/|$)/);
	const path = match?.[1];
	const name = match?.[2];
	if (!path || !name) return null;
	return { path, name };
}

/**
 * Given the ordered executable paths of a process and its ancestors
 * (self first, launchd last), return the `.app` bundle macOS holds
 * responsible for Full Disk Access — the top-most (closest to launchd)
 * ancestor that lives inside a bundle. Returns `null` when no ancestor is
 * inside a `.app` (pure CLI / ssh / CI).
 */
export function responsibleAppFromExecPaths(execPaths: string[]): AppBundle | null {
	let responsible: AppBundle | null = null;
	for (const p of execPaths) {
		const bundle = appBundleFromPath(p);
		if (bundle) responsible = bundle;
	}
	return responsible;
}

/**
 * Best-effort: walk the process tree from the current process up to launchd
 * via `ps` and return the GUI `.app` bundle macOS attributes Full Disk
 * Access to. FDA is granted to the responsible app at the top of the tree
 * (Terminal, Cursor, Conductor, …), not to the `bun`/`membot`/`bash`
 * process itself — so naming it concretely is the difference between a
 * useful hint and a wrong one. Returns `null` on any failure (the hint then
 * falls back to generic wording); only ever called on the FDA error branch,
 * and apple-notes is darwin-only, so `ps` is always present.
 */
export function responsibleApp(): AppBundle | null {
	try {
		const execPaths: string[] = [];
		let pid = process.pid;
		// Depth cap guards against cycles or a pathological tree; a real
		// ancestry to launchd is only a handful deep.
		for (let depth = 0; depth < 20 && pid > 1; depth++) {
			const out = Bun.spawnSync(["ps", "-o", "ppid=,comm=", "-p", String(pid)]);
			if (!out.success) break;
			const line = out.stdout.toString().trim();
			if (!line) break;
			// First whitespace-delimited token is the ppid; the remainder is
			// the executable path, which may itself contain spaces.
			const space = line.indexOf(" ");
			if (space === -1) break;
			const ppid = Number.parseInt(line.slice(0, space), 10);
			const comm = line.slice(space + 1).trim();
			if (comm) execPaths.push(comm);
			if (!Number.isFinite(ppid) || ppid <= 1) break;
			pid = ppid;
		}
		return responsibleAppFromExecPaths(execPaths);
	} catch {
		return null;
	}
}

/**
 * Build the Full Disk Access hint. When we identified the responsible app
 * we name it and its path explicitly (and tell the user to fully quit and
 * relaunch it — TCC grants only apply on a fresh launch). Otherwise we fall
 * back to the generic terminal/editor wording. Both branches name a concrete
 * next action so the `HelpfulError` hint invariant holds.
 */
export function fullDiskAccessHint(app: AppBundle | null): string {
	const pane =
		"Run `open 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'` to jump straight to the pane.";
	if (app) {
		return `Grant Full Disk Access to "${app.name}" (the app at ${app.path} is what macOS holds responsible — not membot itself) in System Settings → Privacy & Security → Full Disk Access, then fully quit (⌘Q) and relaunch ${app.name} before re-running. ${pane}`;
	}
	return `Grant Full Disk Access to the app that launched membot (your terminal, editor, or agent app — Terminal, iTerm, Warp, Cursor, VSCode, Conductor, etc.) in System Settings → Privacy & Security → Full Disk Access, then fully quit and relaunch it before re-running. ${pane}`;
}

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
			hint: fullDiskAccessHint(responsibleApp()),
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
