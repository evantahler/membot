import { describe, expect, test } from "bun:test";
import { buildSearchText } from "../../src/ingest/search-text.ts";

describe("buildSearchText", () => {
	test("prepends path and description to chunk", () => {
		const out = buildSearchText("docs/auth.md", "Notes on the auth flow", "body text");
		expect(out).toBe("docs/auth.md\nNotes on the auth flow\n\nbody text");
	});

	test("handles null description", () => {
		const out = buildSearchText("p.md", null, "x");
		expect(out).toBe("p.md\n\n\nx");
	});

	test("trims whitespace-only descriptions to empty", () => {
		const out = buildSearchText("p.md", "   \n  ", "x");
		expect(out).toBe("p.md\n\n\nx");
	});
});
