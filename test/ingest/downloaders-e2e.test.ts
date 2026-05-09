import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertPdf } from "../../src/ingest/converter/pdf.ts";
import { BrowserPool } from "../../src/ingest/downloaders/browser.ts";
import { genericWebDownloader } from "../../src/ingest/downloaders/generic-web.ts";
import { githubDownloader } from "../../src/ingest/downloaders/github.ts";
import { logger } from "../../src/output/logger.ts";

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
		pool = new BrowserPool({ storageStatePath: join(tmp, "auth", "browser.json") });
	});

	afterAll(async () => {
		await pool.dispose();
		rmSync(tmp, { recursive: true, force: true });
	});

	test("generic-web downloads www.evantahler.com as a PDF and convertPdf extracts readable text", async () => {
		const url = new URL("https://www.evantahler.com");
		const result = await genericWebDownloader.download(url, { pool, logger });
		expect(result.mimeType).toBe("application/pdf");
		expect(result.bytes.byteLength).toBeGreaterThan(10_000);
		expect(result.downloader).toBe("generic-web");
		expect(result.downloaderArgs).toMatchObject({ rendered: true });
		expect(result.sourceUrl).toBe("https://www.evantahler.com/");
		// PDFs start with the literal magic bytes "%PDF-".
		const head = new TextDecoder().decode(result.bytes.slice(0, 5));
		expect(head).toBe("%PDF-");
		// Run the same converter the ingest pipeline runs on application/pdf;
		// catches regressions in either the downloader (empty / login PDF) or
		// in convertPdf (returns no text).
		const conversion = await convertPdf(result.bytes);
		expect(conversion.markdown.length).toBeGreaterThan(200);
		expect(conversion.markdown).toContain("Evan");
		expect(conversion.markdown).toContain("Engineering");
	}, 120_000);

	test("github downloader pulls the issue body + comments from a public repo", async () => {
		const url = new URL("https://github.com/evantahler/membot/issues/36");
		const result = await githubDownloader.download(url, { pool, logger });
		expect(result.mimeType).toBe("text/html");
		expect(result.bytes.byteLength).toBeGreaterThan(10_000);
		expect(result.downloader).toBe("github");
		expect(result.downloaderArgs).toMatchObject({
			owner: "evantahler",
			repo: "membot",
			kind: "issues",
			number: 36,
		});
		const html = new TextDecoder().decode(result.bytes);
		// Issue body and comment that are checked in on issue #36.
		// The page embeds the issue body once in markup and once in a
		// JSON island; either occurrence is fine.
		expect(html).toContain("This is a test issue for the downloader CI");
		expect(html).toContain("I've got a comment too");
	}, 120_000);
});

if (!SHOULD_RUN) {
	// Surface a single line so the suite's silent-skip is visible.
	logger.warn(
		"e2e downloader tests skipped — run `bunx playwright install chromium` (or unset MEMBOT_SKIP_E2E) to enable.",
	);
}
