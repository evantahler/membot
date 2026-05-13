import { describe, expect, test } from "bun:test";
import { MembotConfigSchema } from "../../src/config/schemas.ts";
import "../../src/ingest/sources/index.ts";
import { findSourceByName } from "../../src/ingest/sources/registry.ts";
import type { PluginCtx } from "../../src/ingest/sources/types.ts";
import { logger } from "../../src/output/logger.ts";

const config = MembotConfigSchema.parse({});

/**
 * Live network test for the public-API plugins (`github`). The Google
 * plugins now require the bundled `gws` CLI plus a logged-in user, so
 * we don't exercise them here — those paths are covered by the unit
 * tests in `gws.test.ts` against a stubbed binary.
 *
 * Skipped when `MEMBOT_SKIP_E2E=1` (CI escape hatch).
 */

const SKIP_E2E = process.env.MEMBOT_SKIP_E2E === "1";

describe.if(!SKIP_E2E)("downloaders end-to-end (live network)", () => {
	test("github plugin pulls the issue body + comments from a public repo", async () => {
		const plugin = findSourceByName("github");
		if (!plugin) throw new Error("github plugin not registered");
		const url = "https://github.com/evantahler/membot/issues/36";
		const entries = await plugin.enumerate(url);
		const entry = entries[0];
		if (!entry) throw new Error("github produced no entry");
		const ctx: PluginCtx = { logger, config };
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
