import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MembotConfigSchema } from "../../../src/config/schemas.ts";
import { withCustomRouters } from "../../../src/config/router-validation.ts";
import { customCommandPlugin } from "../../../src/ingest/sources/custom-command.ts";
import { findSourceForInput } from "../../../src/ingest/sources/registry.ts";
import "../../../src/ingest/sources/index.ts";
import { logger } from "../../../src/output/logger.ts";

const baseConfig = MembotConfigSchema.parse({});

function configWith(
	routers: Array<{
		name: string;
		url_pattern: string;
		command: string;
		args?: string[];
		mime_type?: string;
		post_process?: unknown;
		stdin?: string | null;
	}>,
) {
	const parsed = routers.map((r) => ({
		name: r.name,
		url_pattern: r.url_pattern,
		command: r.command,
		args: r.args ?? [],
		mime_type: r.mime_type ?? "text/markdown",
		post_process: r.post_process ?? "passthrough",
		timeout_ms: 10_000,
		stdin: r.stdin ?? null,
	}));
	return withCustomRouters(baseConfig, parsed as Parameters<typeof withCustomRouters>[1]);
}

/**
 * Write a temporary executable script and return its absolute path.
 * Used to give the custom-command plugin a real executable to spawn
 * without depending on system tools that might not be on PATH (CI etc.).
 */
function writeScript(script: string): { path: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "membot-router-"));
	const path = join(dir, "script.sh");
	writeFileSync(path, `#!/bin/sh\n${script}\n`);
	chmodSync(path, 0o755);
	return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("custom-command plugin dispatch", () => {
	test("dynamic match claims a URL when a router pattern matches", async () => {
		const config = configWith([
			{
				name: "google-docs",
				url_pattern: "^https://docs\\.google\\.com/document/d/(?<doc_id>[a-zA-Z0-9_-]+)",
				command: "echo",
				args: ["{doc_id}"],
			},
		]);
		const matched = findSourceForInput("https://docs.google.com/document/d/abc123/edit", config);
		expect(matched?.name).toBe("custom-command");
	});

	test("dynamic match returns null when no router pattern matches", async () => {
		const config = configWith([
			{
				name: "google-docs",
				url_pattern: "^https://docs\\.google\\.com/document/d/(?<doc_id>[a-zA-Z0-9_-]+)",
				command: "echo",
			},
		]);
		const matched = findSourceForInput("https://example.com/other", config);
		expect(matched).toBeNull();
	});

	test("dynamic match yields to a built-in plugin (github wins over user router)", async () => {
		const config = configWith([
			{
				name: "everything",
				url_pattern: "^https://",
				command: "echo",
			},
		]);
		const matched = findSourceForInput("https://github.com/foo/bar/issues/1", config);
		expect(matched?.name).toBe("github");
	});

	test("enumerate extracts named groups into cursor.vars", async () => {
		const config = configWith([
			{
				name: "google-docs",
				url_pattern: "^https://docs\\.google\\.com/document/d/(?<doc_id>[a-zA-Z0-9_-]+)",
				command: "echo",
				args: ["{doc_id}"],
			},
		]);
		const entries = await customCommandPlugin.enumerate(
			"https://docs.google.com/document/d/abc-123_XYZ/edit",
			{ config, logger },
		);
		expect(entries).toHaveLength(1);
		const entry = entries[0];
		expect(entry?.cursor).toEqual({ router: "google-docs", vars: { doc_id: "abc-123_XYZ" } });
	});

	test("enumerate throws HelpfulError when the URL parses but no pattern matches", async () => {
		const config = configWith([
			{
				name: "google-docs",
				url_pattern: "^https://docs\\.google\\.com/document/d/(?<doc_id>[a-zA-Z0-9_-]+)",
				command: "echo",
			},
		]);
		await expect(customCommandPlugin.enumerate("https://example.com/no-match", { config, logger })).rejects.toThrow(
			/no custom router matches/,
		);
	});
});

describe("custom-command fetch", () => {
	test("primary command stdout becomes the row bytes", async () => {
		const { path, cleanup } = writeScript('printf "hello from %s" "$1"');
		try {
			const config = configWith([
				{
					name: "google-docs",
					url_pattern: "^https://docs\\.google\\.com/document/d/(?<doc_id>[a-zA-Z0-9_-]+)",
					command: path,
					args: ["{doc_id}"],
				},
			]);
			const entries = await customCommandPlugin.enumerate(
				"https://docs.google.com/document/d/abc/edit",
				{ config, logger },
			);
			const entry = entries[0];
			if (!entry) throw new Error("expected entry");
			const fetcher = await customCommandPlugin.openBatchFetcher({ logger, config });
			const downloaded = await fetcher.fetch(entry, { logger, config });
			await fetcher.close();
			expect(new TextDecoder().decode(downloaded.bytes)).toBe("hello from abc");
			expect(downloaded.downloader).toBe("custom-command");
			expect(downloaded.downloaderArgs).toEqual({ router: "google-docs", vars: { doc_id: "abc" } });
			expect(downloaded.mimeType).toBe("text/markdown");
		} finally {
			cleanup();
		}
	});

	test("non-zero exit surfaces stderr in HelpfulError", async () => {
		const { path, cleanup } = writeScript('printf "bad" 1>&2; exit 7');
		try {
			const config = configWith([
				{
					name: "rb",
					url_pattern: "^https://example\\.com/(?<id>\\w+)",
					command: path,
					args: ["{id}"],
				},
			]);
			const entries = await customCommandPlugin.enumerate("https://example.com/abc", { config, logger });
			const entry = entries[0];
			if (!entry) throw new Error("expected entry");
			const fetcher = await customCommandPlugin.openBatchFetcher({ logger, config });
			await expect(fetcher.fetch(entry, { logger, config })).rejects.toThrow(/exited 7.*bad/);
			await fetcher.close();
		} finally {
			cleanup();
		}
	});

	test("docmd post-processor normalizes nbsp/smart-quotes", async () => {
		const { path, cleanup } = writeScript("printf 'hello\\xc2\\xa0\\xe2\\x80\\x9cworld\\xe2\\x80\\x9d'");
		try {
			const config = configWith([
				{
					name: "doc",
					url_pattern: "^https://docs\\.google\\.com/document/d/(?<doc_id>[a-zA-Z0-9_-]+)",
					command: path,
					args: ["{doc_id}"],
					post_process: "docmd",
				},
			]);
			const entries = await customCommandPlugin.enumerate(
				"https://docs.google.com/document/d/x/edit",
				{ config, logger },
			);
			const entry = entries[0];
			if (!entry) throw new Error("expected entry");
			const fetcher = await customCommandPlugin.openBatchFetcher({ logger, config });
			const downloaded = await fetcher.fetch(entry, { logger, config });
			await fetcher.close();
			expect(new TextDecoder().decode(downloaded.bytes)).toBe('hello "world"');
		} finally {
			cleanup();
		}
	});

	test("rehydrateEntry fails when the router has been removed from config", async () => {
		// Empty router list — simulates a row that pointed at a router the
		// user has since `membot router remove`d.
		const config = configWith([]);
		const entry = customCommandPlugin.rehydrateEntry("https://example.com/123", {
			router: "ghost",
			vars: { id: "123" },
		});
		const fetcher = await customCommandPlugin.openBatchFetcher({ logger, config });
		await expect(fetcher.fetch(entry, { logger, config })).rejects.toThrow(/no longer registered/);
		await fetcher.close();
	});

	test("stdin payload reaches the spawned command and {var} is substituted", async () => {
		// The script reads stdin and prefixes with the arg, so we can verify
		// both the substitution into argv and the substitution into stdin.
		const { path, cleanup } = writeScript('read line; printf "%s:%s" "$1" "$line"');
		try {
			const config = configWith([
				{
					name: "stdin-router",
					url_pattern: "^https://example\\.com/(?<id>\\w+)",
					command: path,
					args: ["{id}"],
					stdin: "from-stdin-{id}",
				},
			]);
			const entries = await customCommandPlugin.enumerate("https://example.com/abc", { config, logger });
			const entry = entries[0];
			if (!entry) throw new Error("expected entry");
			const fetcher = await customCommandPlugin.openBatchFetcher({ logger, config });
			const downloaded = await fetcher.fetch(entry, { logger, config });
			await fetcher.close();
			expect(new TextDecoder().decode(downloaded.bytes)).toBe("abc:from-stdin-abc");
		} finally {
			cleanup();
		}
	});
});
