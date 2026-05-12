import type { AppContext } from "../../context.ts";
import { listCurrent, tombstone } from "../../db/files.ts";
import { HelpfulError } from "../../errors.ts";
import { buildAppleNotesLogicalPath } from "./logical-path.ts";
import { assertAppleNotesPlatform, mapAppleNotesError } from "./platform.ts";
import { type AppleNotesReader, openNoteReader } from "./reader.ts";
import { type AppleNotesScope, compileScopeMatchers } from "./scope.ts";

export { assertAppleNotesPlatform, mapAppleNotesError } from "./platform.ts";
export type { AppleNotesReader } from "./reader.ts";
export { openNoteReader } from "./reader.ts";
export type { AppleNotesScope } from "./scope.ts";
export { APPLE_NOTES_PREFIX, parseAppleNotesScope } from "./scope.ts";

/**
 * One enumerated note awaiting ingest. The reader is held open for the
 * duration of a batch so each `fetchEnumeratedNote` call hits the cached
 * SQLite + protobuf state — no per-note process spawn.
 */
export interface EnumeratedNote {
	noteId: number;
	accountName: string;
	folderName: string;
	title: string;
	modifiedAt: Date;
	createdAt: Date;
	isPasswordProtected: boolean;
	/** Pre-computed logical path: `apple-notes/<account>/<folder>/<title>.md`. */
	defaultLogicalPath: string;
}

/**
 * Materialized note body, ready to flow into the standard persist pipeline.
 * `markdown` is provided directly by macos-ts (decoded from the gzip'd
 * protobuf body), so the converter step is skipped entirely.
 */
export interface FetchedNote {
	noteId: number;
	accountName: string;
	folderName: string;
	title: string;
	modifiedAt: Date;
	markdown: string;
	sourcePath: string;
	downloaderArgs: Record<string, unknown>;
}

/**
 * Internal `apple-notes://` URI used as `source_path` so each row has a
 * deterministic, replay-able identifier. The actual fetch goes through
 * `downloader_args.noteId`; this string is for humans + provenance.
 */
export function appleNotesSourceUri(noteId: number): string {
	return `apple-notes://note/${noteId}`;
}

/**
 * Folders Apple treats as system-managed trash/recycle areas. We skip
 * these on wildcard scopes — sweeping `apple-notes:` into the store
 * would otherwise drag in everything the user deleted in the last 30
 * days, which is almost never what they want. Users who explicitly
 * name a system folder in their scope (e.g.
 * `apple-notes:iCloud/Recently Deleted`) get it back.
 */
const SYSTEM_FOLDERS: readonly string[] = ["Recently Deleted"];

function isSystemFolder(folderName: string): boolean {
	return SYSTEM_FOLDERS.includes(folderName);
}

function scopeIncludesSystemFolder(scope: AppleNotesScope, folderName: string): boolean {
	// "Explicit" = the literal folder name appears as a substring in the
	// folder pattern. Catches `apple-notes:iCloud/Recently Deleted` and
	// `apple-notes:**/Recently Deleted/**`, skips the wildcard-only forms.
	return scope.folderPattern.includes(folderName);
}

/**
 * Walk the scope and yield every note that matches. macos-ts is fast
 * enough that buffering the full list is fine even for thousands of notes
 * — the heavy work happens in the embed step downstream. Password-protected
 * notes are filtered here so workers never see them.
 *
 * Account resolution: in practice many NoteStore.sqlite schemas leave
 * folder/note `accountName` blank — accounts and folders aren't joined
 * via the obvious foreign key. We instead read `listAccounts()` as the
 * source of truth, and:
 *   - with exactly one account, every folder/note inherits that account
 *     name (the common case — most Macs only have iCloud);
 *   - with multiple accounts, we use whichever accountName the row
 *     reports, falling back to the empty string (which can still match
 *     a wildcard scope).
 */
export function enumerateNotes(scope: AppleNotesScope, reader: AppleNotesReader): EnumeratedNote[] {
	const { matchAccount, matchFolder } = compileScopeMatchers(scope);
	const accounts = reader.listAccounts();
	const soleAccountName = accounts.length === 1 ? accounts[0]?.name : undefined;
	const out: EnumeratedNote[] = [];
	const seenNoteIds = new Set<number>();
	for (const folder of reader.listFolders()) {
		if (folder.noteCount === 0) continue;
		if (!matchFolder(folder.name)) continue;
		if (isSystemFolder(folder.name) && !scopeIncludesSystemFolder(scope, folder.name)) continue;
		// listNotesIn with an empty account → no account filter applied,
		// so a folder name that exists in multiple accounts (e.g. "Inbox")
		// returns the superset; we dedupe via seenNoteIds and resolve each
		// note's account from its own row.
		const notes = reader.listNotesIn("", folder.name);
		for (const note of notes) {
			if (note.isPasswordProtected) continue;
			if (seenNoteIds.has(note.id)) continue;
			const effectiveAccountName = soleAccountName ?? note.accountName ?? folder.accountName ?? "";
			if (!matchAccount(effectiveAccountName)) continue;
			seenNoteIds.add(note.id);
			out.push({
				noteId: note.id,
				accountName: effectiveAccountName,
				folderName: folder.name,
				title: note.title,
				modifiedAt: note.modifiedAt,
				createdAt: note.createdAt,
				isPasswordProtected: false,
				defaultLogicalPath: buildAppleNotesLogicalPath({
					accountName: effectiveAccountName,
					folderPath: folder.name,
					title: note.title,
				}),
			});
		}
	}
	return out;
}

/**
 * Fetch a single note's body. Used by ingest workers and by the refresh
 * runner. The shape matches what `persistVersion` needs (markdown +
 * provenance), so the caller can wire it straight through.
 */
export function fetchEnumeratedNote(reader: AppleNotesReader, noteId: number): FetchedNote {
	const result = reader.readNote(noteId);
	return {
		noteId,
		accountName: result.meta.accountName,
		folderName: result.meta.folderName,
		title: result.meta.title,
		modifiedAt: result.meta.modifiedAt,
		markdown: result.markdown,
		sourcePath: appleNotesSourceUri(noteId),
		downloaderArgs: {
			noteId,
			accountName: result.meta.accountName,
			folderName: result.meta.folderName,
			title: result.meta.title,
		},
	};
}

/**
 * Open a reader for the live database after asserting we're on macOS.
 * Callers must `close()` the returned reader when done.
 */
export function openAppleNotes(): AppleNotesReader {
	assertAppleNotesPlatform();
	try {
		return openNoteReader();
	} catch (err) {
		throw mapAppleNotesError(err);
	}
}

/**
 * Result of a `--sync` reconcile pass: every logical_path that was
 * tombstoned because its underlying note is no longer in Apple Notes.
 */
export interface SyncResult {
	tombstoned: string[];
}

/**
 * Tombstone every current apple-notes row that matches `scope` but whose
 * `noteId` is missing from the live enumeration. Scope-aware: a narrow
 * scope like `apple-notes:Personal/Recipes` only reconciles rows that
 * fall under that account + folder. Rows whose downloader_args don't
 * carry account/folder/noteId metadata are skipped defensively.
 */
export async function syncTombstoneAppleNotes(
	ctx: AppContext,
	scope: AppleNotesScope,
	liveNoteIds: ReadonlySet<number>,
): Promise<SyncResult> {
	const { matchAccount, matchFolder } = compileScopeMatchers(scope);
	const rows = await listCurrent(ctx.db, { prefix: "apple-notes/", limit: 100_000 });
	const tombstoned: string[] = [];
	for (const row of rows) {
		if (row.downloader !== "apple-notes") continue;
		const args = (row.downloader_args ?? {}) as Record<string, unknown>;
		const noteId = args.noteId;
		const account = args.accountName;
		const folder = args.folderName;
		if (typeof noteId !== "number" || typeof account !== "string" || typeof folder !== "string") continue;
		if (!matchAccount(account)) continue;
		if (!matchFolder(folder)) continue;
		if (liveNoteIds.has(noteId)) continue;
		await tombstone(ctx.db, row.logical_path, `sync: note ${noteId} deleted from Apple Notes`);
		tombstoned.push(row.logical_path);
	}
	return { tombstoned };
}

/**
 * Refresh-time helper: fetch one note by its persisted noteId, mapping a
 * NotFound from macos-ts into a HelpfulError that points the user at the
 * `--sync` reconcile path.
 */
export function fetchNoteForRefresh(reader: AppleNotesReader, noteId: number): FetchedNote {
	try {
		return fetchEnumeratedNote(reader, noteId);
	} catch (err) {
		if (err instanceof HelpfulError && err.kind === "not_found") {
			throw new HelpfulError({
				kind: "not_found",
				message: `Apple Note ${noteId} no longer exists`,
				hint: "Reconcile the store with `membot add apple-notes: --sync` to tombstone deleted notes, or remove this row with `membot remove <logical_path>`.",
				cause: err,
			});
		}
		throw err;
	}
}
