import { describe, expect, test } from "bun:test";
import {
	buildAppleNotesLogicalPath,
	disambiguateLogicalPath,
	slugFolderPath,
	slugSegment,
} from "../../../src/ingest/apple-notes/logical-path.ts";

describe("slugSegment", () => {
	test("lowercases and dashes non-alphanumerics", () => {
		expect(slugSegment("Hello, World!")).toBe("hello-world");
	});

	test("collapses runs of non-alphanumerics", () => {
		expect(slugSegment("foo   ---bar")).toBe("foo-bar");
	});

	test("trims edge dashes", () => {
		expect(slugSegment("--foo--")).toBe("foo");
	});

	test("empty → untitled", () => {
		expect(slugSegment("")).toBe("untitled");
		expect(slugSegment("   ")).toBe("untitled");
		expect(slugSegment("!!!")).toBe("untitled");
	});

	test("caps at 80 chars", () => {
		const long = "a".repeat(200);
		expect(slugSegment(long).length).toBeLessThanOrEqual(80);
	});

	test("unicode normalized to ASCII-friendly form", () => {
		expect(slugSegment("café")).toBe("cafe");
	});
});

describe("slugFolderPath", () => {
	test("splits and slugs nested folder path", () => {
		expect(slugFolderPath("Work/Meetings")).toBe("work/meetings");
	});

	test("single folder", () => {
		expect(slugFolderPath("Notes")).toBe("notes");
	});

	test("empty becomes untitled", () => {
		expect(slugFolderPath("")).toBe("untitled");
	});
});

describe("buildAppleNotesLogicalPath", () => {
	test("typical case", () => {
		expect(
			buildAppleNotesLogicalPath({ accountName: "iCloud", folderPath: "Recipes", title: "Grandma's Pasta Sauce" }),
		).toBe("apple-notes/icloud/recipes/grandma-s-pasta-sauce.md");
	});

	test("nested folder + special chars in title", () => {
		expect(
			buildAppleNotesLogicalPath({
				accountName: "Personal",
				folderPath: "Work/Meetings",
				title: "2026-Q1: Planning",
			}),
		).toBe("apple-notes/personal/work/meetings/2026-q1-planning.md");
	});

	test("empty title becomes untitled", () => {
		expect(buildAppleNotesLogicalPath({ accountName: "iCloud", folderPath: "Inbox", title: "" })).toBe(
			"apple-notes/icloud/inbox/untitled.md",
		);
	});
});

describe("disambiguateLogicalPath", () => {
	test("inserts hash before .md extension", () => {
		expect(disambiguateLogicalPath("apple-notes/icloud/recipes/pasta.md", "abcdef0123456789")).toBe(
			"apple-notes/icloud/recipes/pasta-abcdef01.md",
		);
	});

	test("appends to extensionless path", () => {
		expect(disambiguateLogicalPath("apple-notes/icloud/recipes/pasta", "abcdef0123456789")).toBe(
			"apple-notes/icloud/recipes/pasta-abcdef01",
		);
	});

	test("deterministic for same hash", () => {
		const a = disambiguateLogicalPath("x/y.md", "00112233445566");
		const b = disambiguateLogicalPath("x/y.md", "00112233445566");
		expect(a).toBe(b);
	});
});
