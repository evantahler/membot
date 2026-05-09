import { HelpfulError } from "../../errors.ts";
import { sha256Hex } from "../local-reader.ts";
import { safeResolveUrl } from "./browser.ts";
import type { DownloadedRemote, Downloader } from "./index.ts";

const ISSUE_PATH = /^\/([^/]+)\/issue\/([A-Z]+-\d+)(?:$|\/|#|\?)/;
const PROJECT_PATH = /^\/([^/]+)\/project\/([^/?#]+)/;

/**
 * Render a Linear issue or project page (Linear's web UI is a heavy
 * SPA, so a real `page.goto` is the only way without an API key)
 * into HTML, then let `convertHtml` produce markdown. We accept that
 * the rendered HTML carries some chrome (sidebars, command palette
 * shortcuts) — `convertHtml` strips most of it and the embedder is
 * tolerant. If this proves noisy, swap to a targeted DOM scrape via
 * `page.evaluate` later.
 */
export const linearDownloader: Downloader = {
	name: "linear",
	description: "Linear (linear.app/<workspace>/issue/<KEY> and /project/<slug>) — renders the SPA-loaded page as HTML.",
	matches(url) {
		return url.hostname === "linear.app" && (ISSUE_PATH.test(url.pathname) || PROJECT_PATH.test(url.pathname));
	},
	async download(url, ctx): Promise<DownloadedRemote> {
		const args = parseLinearUrl(url);
		const page = await ctx.pool.newPage();
		try {
			const response = await page.goto(url.toString(), { waitUntil: "networkidle", timeout: 45_000 });
			// Linear redirects unauthenticated requests to its marketing
			// login page at `linear.app/login` (same host) or
			// `app.linear.app/login` for workspace-scoped sessions.
			const finalUrl = safeResolveUrl(page.url(), url.toString());
			const finalHost = finalUrl?.hostname ?? "";
			if (
				(finalHost === "linear.app" || finalHost === "app.linear.app") &&
				/^\/(login|signin|sign-in)\b/i.test(finalUrl?.pathname ?? "")
			) {
				throw new HelpfulError({
					kind: "auth_error",
					message: `Linear redirected ${url.toString()} to a login page.`,
					hint: "Run `membot login` and sign into Linear in the browser that opens, then re-run.",
				});
			}
			if (response && !response.ok() && response.status() !== 304) {
				throw new HelpfulError({
					kind: "network_error",
					message: `Linear returned ${response.status()} for ${url.toString()}.`,
					hint: "Open the URL in your browser to verify the workspace + issue are visible to your account.",
				});
			}
			const html = await page.content();
			const bytes = new TextEncoder().encode(html);
			return {
				bytes,
				sha256: sha256Hex(bytes),
				mimeType: "text/html",
				downloader: "linear",
				downloaderArgs: args,
				sourceUrl: url.toString(),
			};
		} finally {
			await page.close().catch(() => {});
		}
	},
};

function parseLinearUrl(url: URL): Record<string, unknown> {
	const issueMatch = url.pathname.match(ISSUE_PATH);
	if (issueMatch) return { kind: "issue", workspace: issueMatch[1], key: issueMatch[2] };
	const projectMatch = url.pathname.match(PROJECT_PATH);
	if (projectMatch) return { kind: "project", workspace: projectMatch[1], slug: projectMatch[2] };
	throw new HelpfulError({
		kind: "input_error",
		message: `not a Linear issue/project URL: ${url.toString()}`,
		hint: "Pass a URL like https://linear.app/<workspace>/issue/<KEY> or .../project/<slug>.",
	});
}
