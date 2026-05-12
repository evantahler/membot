import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MembotConfigSchema } from "../../src/config/schemas.ts";
import { convertPdf } from "../../src/ingest/converter/pdf.ts";
import "../../src/ingest/sources/index.ts";
import { BrowserPool } from "../../src/ingest/sources/browser.ts";
import { findSourceByName } from "../../src/ingest/sources/registry.ts";
import type { PluginCtx } from "../../src/ingest/sources/types.ts";
import { logger } from "../../src/output/logger.ts";

const config = MembotConfigSchema.parse({});

/**
 * Live network tests against two stable public URLs:
 *   - https://www.evantahler.com (generic-web → page.pdf())
 *   - https://github.com/evantahler/membot/issues/36 (github → page.content())
 *
 * Issue #36 is intentionally trivial and unlikely to change ("A test
 * issue for downloder"); the assertions below check the canonical
 * substrings the issue + its comment are guaranteed to contain. Both
 * targets are public so no `membot login` is required.
 *
 * Tests are skipped (with a logged note) when:
 *   - the Playwright chromium binary isn't installed yet
 *     (`bunx playwright install chromium`); or
 *   - `MEMBOT_SKIP_E2E=1` is set (CI escape hatch).
 */

const SKIP_E2E = process.env.MEMBOT_SKIP_E2E === "1";

function chromiumAvailable(): boolean {
	const cacheRoot =
		process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(process.env.HOME ?? "", "Library/Caches/ms-playwright");
	if (!existsSync(cacheRoot)) {
		// linux fallback path
		const linux = join(process.env.HOME ?? "", ".cache/ms-playwright");
		return existsSync(linux);
	}
	return true;
}

const SHOULD_RUN = !SKIP_E2E && chromiumAvailable();

describe.if(SHOULD_RUN)("downloaders end-to-end (live network, chromium)", () => {
	let tmp: string;
	let pool: BrowserPool;

	beforeAll(() => {
		tmp = mkdtempSync(join(tmpdir(), "membot-e2e-"));
		pool = new BrowserPool({ userDataDir: join(tmp, "auth", "browser-profile") });
	});

	afterAll(async () => {
		await pool.dispose();
		rmSync(tmp, { recursive: true, force: true });
	});

	test("generic-web downloads www.evantahler.com as a PDF and convertPdf extracts readable text", async () => {
		const plugin = findSourceByName("generic-web");
		if (!plugin) throw new Error("generic-web plugin not registered");
		const url = "https://www.evantahler.com";
		const entries = await plugin.enumerate(url);
		const entry = entries[0];
		if (!entry) throw new Error("generic-web produced no entry");
		const ctx: PluginCtx = { pool, logger, config };
		const fetcher = await plugin.openBatchFetcher(ctx);
		try {
			const result = await fetcher.fetch(entry, ctx);
			expect(result.mimeType).toBe("application/pdf");
			expect(result.bytes.byteLength).toBeGreaterThan(10_000);
			expect(result.downloader).toBe("generic-web");
			expect(result.downloaderArgs).toMatchObject({ rendered: true });
			expect(result.sourceUrl).toBe("https://www.evantahler.com/");
			// PDFs start with the literal magic bytes "%PDF-".
			const head = new TextDecoder().decode(result.bytes.slice(0, 5));
			expect(head).toBe("%PDF-");
			// Run the same converter the ingest pipeline runs on application/pdf;
			// catches regressions in either the plugin (empty / login PDF) or
			// in convertPdf (returns no text).
			const markdown = await convertPdf(result.bytes);
			expect(markdown.length).toBeGreaterThan(200);
			expect(markdown).toContain("Evan");
			expect(markdown).toContain("Engineering");
		} finally {
			await fetcher.close();
		}
	}, 120_000);

	test("github plugin pulls the issue body + comments from a public repo", async () => {
		const plugin = findSourceByName("github");
		if (!plugin) throw new Error("github plugin not registered");
		const url = "https://github.com/evantahler/membot/issues/36";
		const entries = await plugin.enumerate(url);
		const entry = entries[0];
		if (!entry) throw new Error("github produced no entry");
		const ctx: PluginCtx = { pool, logger, config };
		const fetcher = await plugin.openBatchFetcher(ctx);
		try {
			const result = await fetcher.fetch(entry, ctx);
			expect(result.mimeType).toBe("text/markdown");
			expect(result.downloader).toBe("github");
			expect(result.downloaderArgs).toMatchObject({
				owner: "evantahler",
				repo: "membot",
				kind: "issues",
				number: 36,
			});
			const md = new TextDecoder().decode(result.bytes);
			// The rendered markdown should include the issue title, body,
			// and the seeded comment text (these are checked in on #36).
			expect(md).toContain("# Issue #36: A test issue for downloder");
			expect(md).toContain("This is a test issue for the downloader CI");
			expect(md).toContain("I've got a comment too");
		} finally {
			await fetcher.close();
		}
	}, 120_000);
});

if (!SHOULD_RUN) {
	// Surface a single line so the suite's silent-skip is visible.
	logger.warn(
		"e2e downloader tests skipped — run `bunx playwright install chromium` (or unset MEMBOT_SKIP_E2E) to enable.",
	);
}
