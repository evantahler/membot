import { Notes } from "macos-ts";
import { mapAppleNotesError } from "./platform.ts";

export interface AppleNotesAccount {
	id: number;
	name: string;
}

export interface AppleNotesFolder {
	id: number;
	name: string;
	accountId: number;
	accountName: string;
	noteCount: number;
}

export interface AppleNotesMeta {
	id: number;
	title: string;
	folderName: string;
	accountName: string;
	createdAt: Date;
	modifiedAt: Date;
	isPasswordProtected: boolean;
}

export interface AppleNotesContent {
	meta: AppleNotesMeta;
	markdown: string;
}

/**
 * Narrow interface over `macos-ts` so tests can swap in a fake without
 * touching the real NoteStore.sqlite. The default factory `openNoteReader`
 * returns the live implementation; ingest code holds only this interface.
 */
export interface AppleNotesReader {
	listAccounts(): AppleNotesAccount[];
	listFolders(accountName?: string): AppleNotesFolder[];
	listNotesIn(accountName: string, folderName: string): AppleNotesMeta[];
	readNote(noteId: number): AppleNotesContent;
	close(): void;
}

/**
 * Open a live reader against the user's Apple Notes database. All macos-ts
 * errors surface as HelpfulError via `mapAppleNotesError`.
 */
export function openNoteReader(): AppleNotesReader {
	let notes: Notes;
	try {
		notes = new Notes();
	} catch (err) {
		throw mapAppleNotesError(err);
	}
	return {
		listAccounts() {
			try {
				return notes.accounts().map((a) => ({ id: a.id, name: a.name }));
			} catch (err) {
				throw mapAppleNotesError(err);
			}
		},
		listFolders(accountName) {
			try {
				return notes.folders(accountName).map((f) => ({
					id: f.id,
					name: f.name,
					accountId: f.accountId,
					accountName: f.accountName,
					noteCount: f.noteCount,
				}));
			} catch (err) {
				throw mapAppleNotesError(err);
			}
		},
		listNotesIn(accountName, folderName) {
			try {
				// Many NoteStore schemas leave note.accountName blank — passing
				// a non-empty account filter through to macos-ts in that case
				// would silently exclude every note. Only forward account when
				// the caller actually has one worth filtering on; account-level
				// matching is the caller's responsibility (see enumerateNotes).
				const query: { folder: string; account?: string } = { folder: folderName };
				if (accountName !== "") query.account = accountName;
				return notes.notes(query).map((n) => ({
					id: n.id,
					title: n.title,
					folderName: n.folderName,
					accountName: n.accountName,
					createdAt: n.createdAt,
					modifiedAt: n.modifiedAt,
					isPasswordProtected: n.isPasswordProtected,
				}));
			} catch (err) {
				throw mapAppleNotesError(err);
			}
		},
		readNote(noteId) {
			try {
				const r = notes.read(noteId);
				return {
					meta: {
						id: r.meta.id,
						title: r.meta.title,
						folderName: r.meta.folderName,
						accountName: r.meta.accountName,
						createdAt: r.meta.createdAt,
						modifiedAt: r.meta.modifiedAt,
						isPasswordProtected: r.meta.isPasswordProtected,
					},
					markdown: r.markdown,
				};
			} catch (err) {
				throw mapAppleNotesError(err);
			}
		},
		close() {
			notes.close();
		},
	};
}
