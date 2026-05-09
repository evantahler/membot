import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MembotConfigSchema } from "../../src/config/schemas.ts";
import type { AppContext } from "../../src/context.ts";
import { closeContext } from "../../src/context.ts";
import { openDb } from "../../src/db/connection.ts";
import { insertVersion } from "../../src/db/files.ts";
import { logger } from "../../src/output/logger.ts";
import { createProgress } from "../../src/output/progress.ts";
import { refreshOne } from "../../src/refresh/runner.ts";

let tmp: string;
let ctx: AppContext;

/**
 * Build an AppContext backed by an ephemeral DuckDB. The mcpx field is
 * stubbed per-test by overwriting `ctx.mcpx` with a minimal object that
 * implements the `.exec()` method runner.ts cares about.
 */
async function makeCtx(): Promise<AppContext> {
	tmp = realpathSync(mkdtempSync(join(tmpdir(), "membot-refresh-")));
	const config = MembotConfigSchema.parse({ data_dir: tmp });
	const db = await openDb(join(tmp, "index.duckdb"));
	return {
		config,
		dataDir: tmp,
		configPath: join(tmp, "config.json"),
		db,
		logger,
		progress: createProgress(),
		mcpx: null,
	};
}

describe("refresh/runner replayFetch on mcpx isError", () => {
	beforeEach(async () => {
		ctx = await makeCtx();
	});

	afterEach(async () => {
		await closeContext(ctx);
		rmSync(tmp, { recursive: true, force: true });
	});

	test("refreshOne reports failed (not ok) when the stored mcpx tool returns isError=true", async () => {
		// Seed a row whose stored fetcher is an mcpx tool that's broken
		// the same way GoogleDocs.EditDocument was for a docs.google.com URL.
		await insertVersion(ctx.db, {
			logical_path: "remotes/docs.google.com/document/d/abc/edit",
			source_type: "remote",
			source_path: "https://docs.google.com/document/d/abc/edit",
			source_sha256: "deadbeef".repeat(8),
			content: "# Real document body",
			content_sha256: "cafef00d".repeat(8),
			mime_type: "text/markdown",
			size_bytes: 20,
			fetcher: "mcpx",
			fetcher_server: "GoogleDocs",
			fetcher_tool: "EditDocument",
			fetcher_args: { url: "https://docs.google.com/document/d/abc/edit", format: "markdown" },
		});

		// Stub mcpx that returns the MCP CallToolResult envelope shape with isError=true.
		let execCalls = 0;
		const stub = {
			async exec(_server: string, _tool: string, _args: Record<string, unknown>) {
				execCalls++;
				return {
					isError: true,
					content: [{ type: "text", text: "Error (tool_call_error): missing required input 'document_id'" }],
				};
			},
		};
		ctx.mcpx = stub as unknown as AppContext["mcpx"];

		const result = await refreshOne(ctx, "remotes/docs.google.com/document/d/abc/edit");

		expect(execCalls).toBe(1);
		expect(result.status).toBe("failed");
		// The error message should name the tool so the user knows where to look.
		expect(result.error).toContain("EditDocument");
		expect(result.error).toContain("isError");
		// And it should NOT have created a new version with the error string as content.
		expect(result.new_version_id).toBeUndefined();
	});

	test("refreshOne does not overwrite the stored content when the tool fails", async () => {
		const path = "remotes/example.com/page";
		await insertVersion(ctx.db, {
			logical_path: path,
			source_type: "remote",
			source_path: "https://example.com/page",
			source_sha256: "a".repeat(64),
			content: "# Original content",
			content_sha256: "b".repeat(64),
			mime_type: "text/markdown",
			size_bytes: 18,
			fetcher: "mcpx",
			fetcher_server: "Example",
			fetcher_tool: "GetPage",
			fetcher_args: { url: "https://example.com/page" },
		});

		ctx.mcpx = {
			async exec() {
				return { isError: true, content: [{ type: "text", text: "boom" }] };
			},
		} as unknown as AppContext["mcpx"];

		await refreshOne(ctx, path);

		// Read the latest row directly: content should still be the original,
		// not "boom" from the failed tool envelope.
		const rows = await ctx.db.queryAll<{ content: string | null }>(
			"SELECT content FROM files WHERE logical_path = ? ORDER BY version_id DESC LIMIT 1",
			path,
		);
		expect(rows[0]?.content).toBe("# Original content");
	});
});
