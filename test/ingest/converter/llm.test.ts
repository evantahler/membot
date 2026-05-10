import { describe, expect, mock, test } from "bun:test";
import { convertWithLlm } from "../../../src/ingest/converter/llm.ts";

const NO_LLM = {
	anthropic_api_key: "",
	converter_model: "",
	chunker_model: "",
	describer_model: "",
	vision_model: "",
	describer_skip_when_titled: true,
};

describe("convertWithLlm without an API key", () => {
	test("returns the input unchanged so the pipeline degrades gracefully", async () => {
		const raw = `{"a": 1}`;
		const out = await convertWithLlm(raw, "application/json", "src", NO_LLM);
		expect(out).toBe(raw);
	});

	test("blank/whitespace-only key is treated the same as missing", async () => {
		const out = await convertWithLlm("hi", "text/plain", "src", { ...NO_LLM, anthropic_api_key: "   " });
		expect(out).toBe("hi");
	});
});

describe("convertWithLlm with mocked Anthropic stream", () => {
	test("returns the streamed markdown text on success", async () => {
		const stream = mock(() => ({
			finalMessage: async () => ({ content: [{ type: "text", text: "# Cleaned\n\nbody." }] }),
		}));
		mock.module("@anthropic-ai/sdk", () => ({
			default: class {
				messages = { stream };
			},
		}));
		const { convertWithLlm: convert } = await import("../../../src/ingest/converter/llm.ts");

		const out = await convert("<h1>raw</h1>", "text/html", "src", {
			...NO_LLM,
			anthropic_api_key: "test-key",
			converter_model: "claude-haiku-4-5-20251001",
		});
		expect(stream).toHaveBeenCalledTimes(1);
		expect(out).toBe("# Cleaned\n\nbody.");
	});

	test("strips a leading ```markdown fence wrapper from the model output", async () => {
		const wrapped = "```markdown\n# Title\n\nbody\n```";
		const stream = mock(() => ({
			finalMessage: async () => ({ content: [{ type: "text", text: wrapped }] }),
		}));
		mock.module("@anthropic-ai/sdk", () => ({
			default: class {
				messages = { stream };
			},
		}));
		const { convertWithLlm: convert } = await import("../../../src/ingest/converter/llm.ts");

		const out = await convert("ignored", "text/plain", "src", {
			...NO_LLM,
			anthropic_api_key: "test-key",
			converter_model: "claude-haiku-4-5-20251001",
		});
		expect(out).toBe("# Title\n\nbody");
	});

	test("falls back to raw input when the API call throws", async () => {
		const stream = mock(() => ({
			finalMessage: async () => {
				throw new Error("boom");
			},
		}));
		mock.module("@anthropic-ai/sdk", () => ({
			default: class {
				messages = { stream };
			},
		}));
		const { convertWithLlm: convert } = await import("../../../src/ingest/converter/llm.ts");

		const out = await convert("raw input", "text/plain", "src", {
			...NO_LLM,
			anthropic_api_key: "test-key",
			converter_model: "claude-haiku-4-5-20251001",
		});
		expect(out).toBe("raw input");
	});

	test("falls back to raw input when the model returns empty text", async () => {
		const stream = mock(() => ({
			finalMessage: async () => ({ content: [{ type: "text", text: "   " }] }),
		}));
		mock.module("@anthropic-ai/sdk", () => ({
			default: class {
				messages = { stream };
			},
		}));
		const { convertWithLlm: convert } = await import("../../../src/ingest/converter/llm.ts");

		const out = await convert("raw input", "text/plain", "src", {
			...NO_LLM,
			anthropic_api_key: "test-key",
			converter_model: "claude-haiku-4-5-20251001",
		});
		expect(out).toBe("raw input");
	});
});
