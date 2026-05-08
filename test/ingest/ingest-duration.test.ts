import { describe, expect, test } from "bun:test";
import { parseDuration } from "../../src/ingest/ingest.ts";

describe("parseDuration", () => {
	test("nullish returns null", () => {
		expect(parseDuration(undefined)).toBeNull();
		expect(parseDuration(null)).toBeNull();
		expect(parseDuration("")).toBeNull();
		expect(parseDuration("   ")).toBeNull();
	});

	test("parses each unit", () => {
		expect(parseDuration("30s")).toBe(30);
		expect(parseDuration("5m")).toBe(300);
		expect(parseDuration("2h")).toBe(7200);
		expect(parseDuration("3d")).toBe(259_200);
	});

	test("case-insensitive", () => {
		expect(parseDuration("5M")).toBe(300);
		expect(parseDuration("2H")).toBe(7200);
	});

	test("invalid forms throw HelpfulError", () => {
		expect(() => parseDuration("nope")).toThrow();
		expect(() => parseDuration("5x")).toThrow();
		expect(() => parseDuration("-5m")).toThrow();
	});
});
