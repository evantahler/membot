import { describe, expect, test } from "bun:test";
import { enumerateNotes } from "../../../src/ingest/apple-notes/index.ts";
import type {
	AppleNotesAccount,
	AppleNotesContent,
	AppleNotesFolder,
	AppleNotesMeta,
	AppleNotesReader,
} from "../../../src/ingest/apple-notes/reader.ts";
import { parseAppleNotesScope } from "../../../src/ingest/apple-notes/scope.ts";

interface FakeNote {
	id: number;
	title: string;
	folderName: string;
	accountName: string;
	body?: string;
	isPasswordProtected?: boolean;
}

function buildFakeReader(notes: FakeNote[]): AppleNotesReader {
	const accountsByName = new Map<string, AppleNotesAccount>();
	const folderKeys = new Set<string>();
	const foldersById = new Map<string, AppleNotesFolder>();
	let nextAccountId = 1;
	let nextFolderId = 1;
	for (const n of notes) {
		if (!accountsByName.has(n.accountName)) {
			accountsByName.set(n.accountName, { id: nextAccountId++, name: n.accountName });
		}
		const key = `${n.accountName}::${n.folderName}`;
		if (!folderKeys.has(key)) {
			folderKeys.add(key);
			const account = accountsByName.get(n.accountName)!;
			foldersById.set(key, {
				id: nextFolderId++,
				name: n.folderName,
				accountId: account.id,
				accountName: account.name,
				noteCount: 0,
			});
		}
		const f = foldersById.get(key)!;
		f.noteCount += 1;
	}
	return {
		listAccounts: () => [...accountsByName.values()],
		listFolders: (accountName) => {
			const all = [...foldersById.values()];
			return accountName ? all.filter((f) => f.accountName === accountName) : all;
		},
		listNotesIn: (accountName, folderName) =>
			notes
				.filter((n) => {
					if (n.folderName !== folderName) return false;
					return accountName === "" ? true : n.accountName === accountName;
				})
				.map<AppleNotesMeta>((n) => ({
					id: n.id,
					title: n.title,
					folderName: n.folderName,
					accountName: n.accountName,
					createdAt: new Date(0),
					modifiedAt: new Date(0),
					isPasswordProtected: n.isPasswordProtected ?? false,
				})),
		readNote: (noteId): AppleNotesContent => {
			const note = notes.find((n) => n.id === noteId);
			if (!note) throw new Error(`note ${noteId} not in fake`);
			return {
				meta: {
					id: note.id,
					title: note.title,
					folderName: note.folderName,
					accountName: note.accountName,
					createdAt: new Date(0),
					modifiedAt: new Date(0),
					isPasswordProtected: note.isPasswordProtected ?? false,
				},
				markdown: note.body ?? `# ${note.title}\n\nbody`,
			};
		},
		close: () => {},
	};
}

const FIXTURE: FakeNote[] = [
	{ id: 1, title: "Pasta", folderName: "Recipes", accountName: "Personal" },
	{ id: 2, title: "Risotto", folderName: "Recipes", accountName: "Personal" },
	{ id: 3, title: "Q1 Plan", folderName: "Meetings", accountName: "Work" },
	{ id: 4, title: "Locked Secret", folderName: "Inbox", accountName: "Personal", isPasswordProtected: true },
	{ id: 5, title: "Idea", folderName: "Inbox", accountName: "Work" },
];

describe("enumerateNotes", () => {
	test("bare scope matches every non-locked note", () => {
		const reader = buildFakeReader(FIXTURE);
		const result = enumerateNotes(parseAppleNotesScope("apple-notes:"), reader);
		expect(result.map((n) => n.noteId).sort()).toEqual([1, 2, 3, 5]);
	});

	test("password-protected notes are filtered", () => {
		const reader = buildFakeReader(FIXTURE);
		const result = enumerateNotes(parseAppleNotesScope("apple-notes:Personal/Inbox"), reader);
		expect(result).toEqual([]);
	});

	test("scoped to single account/folder", () => {
		const reader = buildFakeReader(FIXTURE);
		const result = enumerateNotes(parseAppleNotesScope("apple-notes:Personal/Recipes"), reader);
		expect(result.map((n) => n.noteId).sort()).toEqual([1, 2]);
	});

	test("wildcard account + literal folder picks across accounts", () => {
		const reader = buildFakeReader(FIXTURE);
		const result = enumerateNotes(parseAppleNotesScope("apple-notes:*/Inbox"), reader);
		expect(result.map((n) => n.noteId).sort()).toEqual([5]);
	});

	test("default logical_path is slugged", () => {
		const reader = buildFakeReader(FIXTURE);
		const result = enumerateNotes(parseAppleNotesScope("apple-notes:Personal/Recipes"), reader);
		const pasta = result.find((n) => n.noteId === 1);
		expect(pasta?.defaultLogicalPath).toBe("apple-notes/personal/recipes/pasta.md");
	});
});
