import { describe, expect, test } from "bun:test";
import { DatabaseAccessDeniedError, DatabaseNotFoundError, PasswordProtectedError } from "macos-ts";
import { HelpfulError } from "../../../src/errors.ts";
import {
	appBundleFromPath,
	fullDiskAccessHint,
	mapAppleNotesError,
	responsibleAppFromExecPaths,
} from "../../../src/ingest/apple-notes/platform.ts";

describe("appBundleFromPath", () => {
	test("resolves the real Conductor tree path to Conductor.app", () => {
		const bundle = appBundleFromPath("/Applications/Conductor.app/Contents/MacOS/conductor");
		expect(bundle).toEqual({ path: "/Applications/Conductor.app", name: "Conductor" });
	});

	test("picks the outer-most bundle when a helper bundle is nested inside", () => {
		const bundle = appBundleFromPath(
			"/Applications/Cursor.app/Contents/Frameworks/Cursor Helper.app/Contents/MacOS/Cursor Helper",
		);
		expect(bundle).toEqual({ path: "/Applications/Cursor.app", name: "Cursor" });
	});

	test("handles bundle paths containing spaces", () => {
		const bundle = appBundleFromPath("/Users/evan/Library/Application Support/My Editor.app/Contents/MacOS/My Editor");
		expect(bundle).toEqual({
			path: "/Users/evan/Library/Application Support/My Editor.app",
			name: "My Editor",
		});
	});

	test("returns null for a path with no .app segment", () => {
		expect(appBundleFromPath("/bin/zsh")).toBeNull();
		expect(appBundleFromPath("/usr/local/bin/membot")).toBeNull();
	});

	test("returns null for an empty path", () => {
		expect(appBundleFromPath("")).toBeNull();
	});

	test("does not match a literal .app file that is not a bundle directory", () => {
		// `.app` must be a path segment (followed by `/` or end-of-string),
		// not a substring of a filename like `notes.application`.
		expect(appBundleFromPath("/tmp/notes.application/x")).toBeNull();
	});
});

describe("responsibleAppFromExecPaths", () => {
	test("returns the top-most (closest to launchd) .app ancestor", () => {
		// Ordered self-first, launchd-last — mirrors the live Conductor tree.
		const tree = [
			"/bin/zsh",
			"/Users/evan/Library/Application Support/com.conductor.app/agent-binaries/claude/2.1.156/claude",
			"/Users/evan/Library/Application Support/com.conductor.app/bin/.internal/conductor-runtime",
			"/Applications/Conductor.app/Contents/MacOS/conductor",
		];
		expect(responsibleAppFromExecPaths(tree)).toEqual({
			path: "/Applications/Conductor.app",
			name: "Conductor",
		});
	});

	test("prefers the outermost app when multiple ancestors are bundled", () => {
		const tree = [
			"/Applications/iTerm.app/Contents/MacOS/iTerm2",
			"/Applications/Conductor.app/Contents/MacOS/conductor",
		];
		// Conductor is later in the list (closer to launchd) → it wins.
		expect(responsibleAppFromExecPaths(tree)).toEqual({
			path: "/Applications/Conductor.app",
			name: "Conductor",
		});
	});

	test("returns null when no ancestor lives in a bundle (CLI / ssh / CI)", () => {
		expect(responsibleAppFromExecPaths(["/bin/zsh", "/usr/bin/sshd", "/sbin/launchd"])).toBeNull();
	});

	test("returns null for an empty tree", () => {
		expect(responsibleAppFromExecPaths([])).toBeNull();
	});
});

describe("fullDiskAccessHint", () => {
	test("names the detected app, its path, and the quit/relaunch step", () => {
		const hint = fullDiskAccessHint({ path: "/Applications/Conductor.app", name: "Conductor" });
		expect(hint).toContain("Conductor");
		expect(hint).toContain("/Applications/Conductor.app");
		expect(hint).toContain("not membot itself");
		expect(hint.toLowerCase()).toContain("relaunch");
		expect(hint).toContain("Privacy_AllFiles");
	});

	test("falls back to generic wording (still naming a concrete next step) when no app detected", () => {
		const hint = fullDiskAccessHint(null);
		expect(hint).toContain("the app that launched membot");
		expect(hint).toContain("Privacy_AllFiles");
		expect(hint.length).toBeGreaterThan(0);
	});
});

describe("mapAppleNotesError", () => {
	test("maps DatabaseAccessDeniedError to an auth_error with a non-empty FDA hint", () => {
		const mapped = mapAppleNotesError(new DatabaseAccessDeniedError("denied"));
		expect(mapped).toBeInstanceOf(HelpfulError);
		expect(mapped.kind).toBe("auth_error");
		expect(mapped.message).toBe("Cannot read the Apple Notes database — Full Disk Access required");
		// The hint is dynamic (depends on the live process tree) but must
		// always satisfy the non-empty invariant and point at the FDA pane.
		expect(mapped.hint.length).toBeGreaterThan(0);
		expect(mapped.hint).toContain("Privacy_AllFiles");
	});

	test("maps DatabaseNotFoundError to a not_found error", () => {
		const mapped = mapAppleNotesError(new DatabaseNotFoundError("missing"));
		expect(mapped.kind).toBe("not_found");
		expect(mapped.message).toBe("Apple Notes database not found");
		expect(mapped.hint.length).toBeGreaterThan(0);
	});

	test("maps PasswordProtectedError to an auth_error", () => {
		const mapped = mapAppleNotesError(new PasswordProtectedError(101));
		expect(mapped.kind).toBe("auth_error");
		expect(mapped.message).toContain("password-protected");
	});

	test("wraps an unrecognized error as internal_error", () => {
		const mapped = mapAppleNotesError(new Error("boom"));
		expect(mapped.kind).toBe("internal_error");
		expect(mapped.message).toContain("boom");
	});

	test("passes a HelpfulError through untouched", () => {
		const original = new HelpfulError({ kind: "input_error", message: "x", hint: "y" });
		expect(mapAppleNotesError(original)).toBe(original);
	});
});
