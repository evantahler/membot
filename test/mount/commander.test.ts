import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { z } from "zod";
import { isHelpfulError } from "../../src/errors.ts";
import { applySchemaToCommand } from "../../src/mount/zod-to-cli.ts";
import { composeDescription, defaultCliName, defineOperation } from "../../src/operations/types.ts";

describe("operation framework", () => {
	test("defineOperation passes through identity", () => {
		const op = defineOperation({
			name: "membot_test",
			description: "test",
			inputSchema: z.object({ x: z.string() }),
			outputSchema: z.object({}),
			handler: async () => ({}),
		});
		expect(op.name).toBe("membot_test");
	});

	test("defaultCliName strips membot_ prefix and snake → kebab", () => {
		expect(defaultCliName({ name: "membot_add" })).toBe("add");
		expect(defaultCliName({ name: "membot_long_name" })).toBe("long-name");
		expect(defaultCliName({ name: "x", cliName: "custom" })).toBe("custom");
	});

	test("composeDescription prepends bash equivalent when set", () => {
		expect(composeDescription({ description: "Read a file", bashEquivalent: "cat" })).toBe(
			"[[ bash equivalent: cat ]] Read a file",
		);
		expect(composeDescription({ description: "no bash equivalent" })).toBe("no bash equivalent");
		expect(composeDescription({ description: "blank prefix", bashEquivalent: "  " })).toBe("blank prefix");
	});

	test("applySchemaToCommand registers options derived from zod fields", () => {
		const cmd = new Command("test");
		const schema = z.object({
			source: z.string().describe("source path"),
			limit: z.number().default(10).describe("max items"),
			mode: z.enum(["a", "b"]).default("a").describe("mode"),
			tags: z.array(z.string()).optional().describe("tag list"),
			flag: z.boolean().default(false).describe("on/off"),
		});
		applySchemaToCommand(cmd, schema, { positional: ["source"], aliases: { limit: "-l" } });

		const helpText = cmd.helpInformation();
		expect(helpText).toContain("source");
		expect(helpText).toContain("--limit");
		expect(helpText).toContain("-l, --limit");
		expect(helpText).toContain("--mode");
		expect(helpText).toContain("--tags");
		expect(helpText).toContain("--flag");
	});

	test("number argParser throws HelpfulError on non-numeric input", async () => {
		const cmd = new Command("test").exitOverride().configureOutput({
			writeErr: () => {},
			writeOut: () => {},
		});
		applySchemaToCommand(cmd, z.object({ limit: z.number().describe("max items") }), {});

		let caught: unknown;
		try {
			await cmd.parseAsync(["--limit", "not-a-number"], { from: "user" });
		} catch (err) {
			caught = err;
		}

		expect(caught).toBeDefined();
		// Commander wraps argParser errors in CommanderError but exposes the original via `.cause`.
		const inner = caught instanceof Error && caught.cause !== undefined ? caught.cause : caught;
		expect(isHelpfulError(inner)).toBe(true);
		if (isHelpfulError(inner)) {
			expect(inner.kind).toBe("input_error");
			expect(inner.hint.length).toBeGreaterThan(0);
			expect(inner.message).toContain("--limit");
		}
	});
});
