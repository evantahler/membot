import { describe, expect, test } from "bun:test";
import { asHelpful, HelpfulError, isHelpfulError, mapKindToExit } from "../src/errors.ts";

describe("HelpfulError", () => {
	test("constructs with hint", () => {
		const e = new HelpfulError({ kind: "not_found", message: "missing", hint: "Run membot ls." });
		expect(e.kind).toBe("not_found");
		expect(e.hint).toBe("Run membot ls.");
		expect(e.message).toBe("missing");
		expect(e.name).toBe("HelpfulError");
	});

	test("rejects empty hint at runtime", () => {
		expect(() => new HelpfulError({ kind: "not_found", message: "x", hint: "" })).toThrow();
		expect(() => new HelpfulError({ kind: "not_found", message: "x", hint: "   " })).toThrow();
	});

	test("isHelpfulError narrows", () => {
		const e = new HelpfulError({ kind: "input_error", message: "x", hint: "y" });
		expect(isHelpfulError(e)).toBe(true);
		expect(isHelpfulError(new Error("plain"))).toBe(false);
		expect(isHelpfulError("string")).toBe(false);
	});

	test("asHelpful preserves an existing HelpfulError", () => {
		const original = new HelpfulError({ kind: "auth_error", message: "401", hint: "auth" });
		const wrapped = asHelpful(original, "ctx", "h");
		expect(wrapped).toBe(original);
	});

	test("asHelpful wraps non-HelpfulError causes", () => {
		const wrapped = asHelpful(new Error("boom"), "while reading", "Try again.", "network_error");
		expect(wrapped).toBeInstanceOf(HelpfulError);
		expect(wrapped.kind).toBe("network_error");
		expect(wrapped.message).toContain("while reading");
		expect(wrapped.message).toContain("boom");
		expect(wrapped.cause).toBeInstanceOf(Error);
	});

	test("mapKindToExit covers every ErrorKind", () => {
		expect(mapKindToExit("input_error")).toBe(2);
		expect(mapKindToExit("not_found")).toBe(3);
		expect(mapKindToExit("conflict")).toBe(4);
		expect(mapKindToExit("auth_error")).toBe(5);
		expect(mapKindToExit("network_error")).toBe(6);
		expect(mapKindToExit("unsupported_mime")).toBe(7);
		expect(mapKindToExit("partial_failure")).toBe(8);
		expect(mapKindToExit("internal_error")).toBe(1);
	});
});
