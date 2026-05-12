import { describe, expect, test } from "bun:test";
import { compileScopeMatchers, parseAppleNotesScope } from "../../../src/ingest/apple-notes/scope.ts";

describe("parseAppleNotesScope", () => {
	test("bare prefix matches everything", () => {
		const s = parseAppleNotesScope("apple-notes:");
		expect(s.accountPattern).toBe("*");
		expect(s.folderPattern).toBe("**");
	});

	test("account only → folder defaults to **", () => {
		const s = parseAppleNotesScope("apple-notes:Personal");
		expect(s.accountPattern).toBe("Personal");
		expect(s.folderPattern).toBe("**");
	});

	test("account + folder split on first slash", () => {
		const s = parseAppleNotesScope("apple-notes:Personal/Recipes");
		expect(s.accountPattern).toBe("Personal");
		expect(s.folderPattern).toBe("Recipes");
	});

	test("nested folder path preserved", () => {
		const s = parseAppleNotesScope("apple-notes:Personal/Work/Meetings/2026");
		expect(s.accountPattern).toBe("Personal");
		expect(s.folderPattern).toBe("Work/Meetings/2026");
	});

	test("trailing slash → match any folder under prefix", () => {
		const s = parseAppleNotesScope("apple-notes:Personal/");
		expect(s.accountPattern).toBe("Personal");
		expect(s.folderPattern).toBe("**");
	});

	test("glob in folder portion preserved", () => {
		const s = parseAppleNotesScope("apple-notes:Personal/Recipes/**");
		expect(s.folderPattern).toBe("Recipes/**");
	});

	test("glob in account portion preserved", () => {
		const s = parseAppleNotesScope("apple-notes:*/Recipes");
		expect(s.accountPattern).toBe("*");
		expect(s.folderPattern).toBe("Recipes");
	});

	test("empty account before slash defaults to wildcard", () => {
		const s = parseAppleNotesScope("apple-notes:/Recipes");
		expect(s.accountPattern).toBe("*");
		expect(s.folderPattern).toBe("Recipes");
	});

	test("rejects non-scheme input", () => {
		expect(() => parseAppleNotesScope("docs/**/*.md")).toThrow(/Apple Notes scope/);
	});
});

describe("compileScopeMatchers", () => {
	test("bare prefix matches any account/folder", () => {
		const m = compileScopeMatchers(parseAppleNotesScope("apple-notes:"));
		expect(m.matchAccount("iCloud")).toBe(true);
		expect(m.matchAccount("Personal")).toBe(true);
		expect(m.matchFolder("Recipes")).toBe(true);
		expect(m.matchFolder("Work/Meetings")).toBe(true);
	});

	test("exact account name", () => {
		const m = compileScopeMatchers(parseAppleNotesScope("apple-notes:Personal"));
		expect(m.matchAccount("Personal")).toBe(true);
		expect(m.matchAccount("iCloud")).toBe(false);
		expect(m.matchFolder("Recipes")).toBe(true);
		expect(m.matchFolder("Work/Meetings")).toBe(true);
	});

	test("exact folder path", () => {
		const m = compileScopeMatchers(parseAppleNotesScope("apple-notes:Personal/Recipes"));
		expect(m.matchFolder("Recipes")).toBe(true);
		expect(m.matchFolder("Recipes/Sub")).toBe(false);
		expect(m.matchFolder("Work")).toBe(false);
	});

	test("recursive glob matches nested folders", () => {
		const m = compileScopeMatchers(parseAppleNotesScope("apple-notes:Personal/Recipes/**"));
		expect(m.matchFolder("Recipes/Italian")).toBe(true);
		expect(m.matchFolder("Recipes/Italian/Pasta")).toBe(true);
		expect(m.matchFolder("Other")).toBe(false);
	});

	test("wildcard account + literal folder", () => {
		const m = compileScopeMatchers(parseAppleNotesScope("apple-notes:*/Recipes"));
		expect(m.matchAccount("iCloud")).toBe(true);
		expect(m.matchAccount("Work")).toBe(true);
		expect(m.matchFolder("Recipes")).toBe(true);
		expect(m.matchFolder("Other")).toBe(false);
	});

	test("** in account portion matches any depth", () => {
		const m = compileScopeMatchers(parseAppleNotesScope("apple-notes:**/Archive/**"));
		// account "**" → matches any account; folder "Archive/**" → Archive
		// and anything beneath it (picomatch `**` matches zero+ segments,
		// which is what users want when they ask for "everything under Archive").
		expect(m.matchAccount("iCloud")).toBe(true);
		expect(m.matchFolder("Archive/Old")).toBe(true);
		expect(m.matchFolder("Archive")).toBe(true);
		expect(m.matchFolder("Inbox")).toBe(false);
	});

	test("prefix glob in folder", () => {
		const m = compileScopeMatchers(parseAppleNotesScope("apple-notes:Personal/Work*"));
		expect(m.matchFolder("Work")).toBe(true);
		expect(m.matchFolder("Workshops")).toBe(true);
		expect(m.matchFolder("Personal")).toBe(false);
	});
});
