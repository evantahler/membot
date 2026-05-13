import { describe, expect, test } from "bun:test";
import {
	compileRouterPattern,
	CustomRoutersSchema,
	type Router,
	RouterSchema,
	validateRouters,
} from "../../src/config/router-validation.ts";

function parseRouter(input: Record<string, unknown>): Router {
	return RouterSchema.parse(input);
}

describe("RouterSchema", () => {
	test("accepts a minimal router with defaults", () => {
		const r = parseRouter({
			name: "g",
			url_pattern: "^https://example\\.com/(?<id>\\w+)",
			command: "echo",
		});
		expect(r.args).toEqual([]);
		expect(r.mime_type).toBe("text/markdown");
		expect(r.post_process).toBe("passthrough");
		expect(r.timeout_ms).toBe(60_000);
		expect(r.stdin).toBeNull();
	});

	test("rejects an empty name", () => {
		expect(() => parseRouter({ name: "", url_pattern: "x", command: "y" })).toThrow();
	});

	test("rejects a name with spaces", () => {
		expect(() => parseRouter({ name: "a b", url_pattern: "x", command: "y" })).toThrow();
	});

	test("accepts a shell post_process object", () => {
		const r = parseRouter({
			name: "g",
			url_pattern: "x",
			command: "y",
			post_process: { command: "pandoc", args: ["-f", "html", "-t", "markdown"] },
		});
		expect(r.post_process).toEqual({ command: "pandoc", args: ["-f", "html", "-t", "markdown"], timeout_ms: 60_000 });
	});
});

describe("compileRouterPattern", () => {
	test("compiles a valid pattern", () => {
		const r = parseRouter({ name: "g", url_pattern: "^abc(?<id>\\d+)", command: "x" });
		expect(compileRouterPattern(r).test("abc123")).toBe(true);
	});

	test("throws HelpfulError on an invalid regex", () => {
		const r = parseRouter({ name: "g", url_pattern: "[unterminated", command: "x" });
		expect(() => compileRouterPattern(r)).toThrow(/invalid url_pattern/);
	});
});

describe("validateRouters", () => {
	test("accepts an empty list", () => {
		expect(() => validateRouters([])).not.toThrow();
	});

	test("rejects duplicate names", () => {
		const a = parseRouter({ name: "g", url_pattern: "x", command: "y" });
		const b = parseRouter({ name: "g", url_pattern: "y", command: "z" });
		expect(() => validateRouters([a, b])).toThrow(/duplicate router name/);
	});

	test("rejects a placeholder that references an unknown group", () => {
		const r = parseRouter({
			name: "g",
			url_pattern: "^abc(?<id>\\d+)",
			command: "x",
			args: ["{missing}"],
		});
		expect(() => validateRouters([r])).toThrow(/no named group/);
	});

	test("allows {url} placeholder without a corresponding group", () => {
		const r = parseRouter({
			name: "g",
			url_pattern: "^abc(?<id>\\d+)",
			command: "x",
			args: ["{id}", "{url}"],
		});
		expect(() => validateRouters([r])).not.toThrow();
	});

	test("validates placeholders inside shell post_process args", () => {
		const r = parseRouter({
			name: "g",
			url_pattern: "^abc(?<id>\\d+)",
			command: "x",
			post_process: { command: "y", args: ["--id", "{missing}"] },
		});
		expect(() => validateRouters([r])).toThrow(/no named group/);
	});
});

describe("CustomRoutersSchema", () => {
	test("rejects an array with duplicate names via superRefine", () => {
		const result = CustomRoutersSchema.safeParse([
			{ name: "g", url_pattern: "x", command: "y" },
			{ name: "g", url_pattern: "y", command: "z" },
		]);
		expect(result.success).toBe(false);
	});

	test("default is an empty array", () => {
		const empty = CustomRoutersSchema.parse(undefined);
		expect(empty).toEqual([]);
	});
});
