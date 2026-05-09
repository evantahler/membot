import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ConfigField,
	enumerateSchemaFields,
	enumerateSchemaPaths,
	getField,
	maskIfSecret,
	resolveSchemaPath,
	runGet,
	runSet,
	runUnset,
} from "../../src/commands/config.ts";
import { loadConfig } from "../../src/config/loader.ts";
import { MembotConfigSchema } from "../../src/config/schemas.ts";
import { isHelpfulError } from "../../src/errors.ts";

let tmp: string;
let prevHome: string | undefined;
let prevApiKey: string | undefined;

const captureStdout = async <T>(fn: () => Promise<T>): Promise<T> => {
	const original = process.stdout.write.bind(process.stdout);
	process.stdout.write = (() => true) as typeof process.stdout.write;
	try {
		return await fn();
	} finally {
		process.stdout.write = original;
	}
};

describe("membot config", () => {
	beforeEach(() => {
		tmp = realpathSync(mkdtempSync(join(tmpdir(), "membot-config-")));
		prevHome = process.env.MEMBOT_HOME;
		prevApiKey = process.env.ANTHROPIC_API_KEY;
		process.env.MEMBOT_HOME = tmp;
		delete process.env.ANTHROPIC_API_KEY;
	});

	afterEach(() => {
		if (prevHome === undefined) delete process.env.MEMBOT_HOME;
		else process.env.MEMBOT_HOME = prevHome;
		if (prevApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
		else process.env.ANTHROPIC_API_KEY = prevApiKey;
		rmSync(tmp, { recursive: true, force: true });
	});

	describe("schema-path helpers", () => {
		test("resolveSchemaPath returns the leaf zod type for a known path", () => {
			const leaf = resolveSchemaPath(MembotConfigSchema, "chunker.target_chars");
			expect(leaf).toBeDefined();
			expect(leaf.safeParse(42).success).toBe(true);
			expect(leaf.safeParse("nope").success).toBe(false);
		});

		test("resolveSchemaPath rejects an unknown top-level key with a HelpfulError", () => {
			let err: unknown;
			try {
				resolveSchemaPath(MembotConfigSchema, "does_not_exist");
			} catch (e) {
				err = e;
			}
			expect(isHelpfulError(err)).toBe(true);
			if (isHelpfulError(err)) {
				expect(err.kind).toBe("input_error");
				expect(err.message).toContain("unknown config key");
				expect(err.hint).toContain("membot config list");
			}
		});

		test("resolveSchemaPath rejects an unknown nested key and suggests the close match", () => {
			let err: unknown;
			try {
				resolveSchemaPath(MembotConfigSchema, "chunkr.target_chars");
			} catch (e) {
				err = e;
			}
			expect(isHelpfulError(err)).toBe(true);
			if (isHelpfulError(err)) {
				expect(err.hint).toContain("chunker.target_chars");
			}
		});

		test("enumerateSchemaPaths covers every nested leaf", () => {
			const paths = enumerateSchemaPaths(MembotConfigSchema);
			expect(paths).toContain("data_dir");
			expect(paths).toContain("chunker.target_chars");
			expect(paths).toContain("llm.anthropic_api_key");
			expect(paths).toContain("daemon.tick_interval_sec");
			expect(paths).toContain("db_lock_retry.max_attempts");
			expect(paths).toContain("default_refresh_frequency_sec");
		});

		test("enumerateSchemaFields tags kind, nullable, and is_secret correctly", () => {
			const fields = enumerateSchemaFields(MembotConfigSchema);
			const byPath = new Map(fields.map((f: ConfigField) => [f.path, f]));

			expect(byPath.get("llm.anthropic_api_key")).toEqual({
				path: "llm.anthropic_api_key",
				kind: "string",
				nullable: false,
				is_secret: true,
			});
			expect(byPath.get("chunker.target_chars")).toEqual({
				path: "chunker.target_chars",
				kind: "number",
				nullable: false,
				is_secret: false,
			});
			expect(byPath.get("default_refresh_frequency_sec")).toEqual({
				path: "default_refresh_frequency_sec",
				kind: "number",
				nullable: true,
				is_secret: false,
			});
			expect(byPath.get("llm.converter_model")?.is_secret).toBe(false);
		});

		test("getField returns metadata for a known path and undefined for unknown", () => {
			expect(getField("llm.anthropic_api_key")?.is_secret).toBe(true);
			expect(getField("chunker.target_chars")?.kind).toBe("number");
			expect(getField("does.not.exist")).toBeUndefined();
		});
	});

	describe("set + get roundtrip", () => {
		test("set writes a top-level scalar and loadConfig reads it back", async () => {
			await captureStdout(() => runSet("embedding_dimension", "256"));
			const { config } = await loadConfig();
			expect(config.embedding_dimension).toBe(256);
		});

		test("set writes a nested scalar and loadConfig reads it back", async () => {
			await captureStdout(() => runSet("chunker.target_chars", "800"));
			const { config } = await loadConfig();
			expect(config.chunker.target_chars).toBe(800);
		});

		test("set persists the API key and loadConfig reads it back when no env var is present", async () => {
			await captureStdout(() => runSet("llm.anthropic_api_key", "sk-ant-test1234567890"));
			const { config } = await loadConfig();
			expect(config.llm.anthropic_api_key).toBe("sk-ant-test1234567890");
		});

		test("ANTHROPIC_API_KEY env var overrides the file at read time", async () => {
			await captureStdout(() => runSet("llm.anthropic_api_key", "from-file"));
			process.env.ANTHROPIC_API_KEY = "from-env";
			const { config } = await loadConfig();
			expect(config.llm.anthropic_api_key).toBe("from-env");
		});

		test("set rejects an invalid value with a HelpfulError naming the field", async () => {
			let err: unknown;
			try {
				await captureStdout(() => runSet("chunker.target_chars", "notanumber"));
			} catch (e) {
				err = e;
			}
			expect(isHelpfulError(err)).toBe(true);
			if (isHelpfulError(err)) {
				expect(err.kind).toBe("input_error");
				expect(err.message).toContain("chunker.target_chars");
			}
		});

		test("set rejects an unknown key with a 'did you mean' hint", async () => {
			let err: unknown;
			try {
				await captureStdout(() => runSet("chunkr.target_chars", "800"));
			} catch (e) {
				err = e;
			}
			expect(isHelpfulError(err)).toBe(true);
			if (isHelpfulError(err)) {
				expect(err.hint).toContain("chunker.target_chars");
			}
		});

		test("get rejects an unknown key", async () => {
			let err: unknown;
			try {
				await captureStdout(() => runGet("does.not.exist", {}));
			} catch (e) {
				err = e;
			}
			expect(isHelpfulError(err)).toBe(true);
		});

		test("unset rejects an unknown key", async () => {
			let err: unknown;
			try {
				await captureStdout(() => runUnset("does.not.exist"));
			} catch (e) {
				err = e;
			}
			expect(isHelpfulError(err)).toBe(true);
		});
	});

	describe("unset", () => {
		test("unset restores the schema default", async () => {
			await captureStdout(() => runSet("chunker.target_chars", "800"));
			await captureStdout(() => runUnset("chunker.target_chars"));
			const { config } = await loadConfig();
			expect(config.chunker.target_chars).toBe(4000);
		});
	});

	describe("file mode", () => {
		test("config file is chmod 0600 after a write", async () => {
			await captureStdout(() => runSet("embedding_dimension", "256"));
			const { configPath } = await loadConfig();
			const mode = statSync(configPath).mode & 0o777;
			expect(mode).toBe(0o600);
		});
	});

	describe("maskIfSecret", () => {
		test("masks llm.anthropic_api_key longer than 11 chars to prefix...suffix", () => {
			expect(maskIfSecret("llm.anthropic_api_key", "sk-ant-abcd1234567890XYZW")).toBe("sk-ant-...XYZW");
		});

		test("returns short or empty values as-is for the secret path (no useful mask)", () => {
			expect(maskIfSecret("llm.anthropic_api_key", "")).toBe("");
			expect(maskIfSecret("llm.anthropic_api_key", "tiny")).toBe("****");
		});

		test("non-secret paths pass through unchanged", () => {
			expect(maskIfSecret("chunker.target_chars", 4000)).toBe(4000);
			expect(maskIfSecret("llm.converter_model", "claude-haiku-4-5")).toBe("claude-haiku-4-5");
		});
	});
});
