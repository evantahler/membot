import { HelpfulError } from "../../errors.ts";
import { sha256Hex } from "../local-reader.ts";
import { safeResolveUrl } from "./browser.ts";
import type { DownloadedRemote, Downloader } from "./index.ts";

const ISSUE_OR_PR = /^\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)(?:$|\/|#|\?)/;

/**
 * Render a GitHub issue or pull-request page (description + every
 * comment in the conversation tab) into HTML, then let `convertHtml`
 * boil it down to markdown. We use `page.goto` + `page.content()`
 * rather than the REST API because the rendered page already
 * concatenates the body, comments, reviews, and timeline events in
 * the order a human reads them, and it inherits the user's logged-in
 * session for private repos automatically.
 */
export const githubDownloader: Downloader = {
	name: "github",
	description:
		"GitHub issues + PRs (github.com/<owner>/<repo>/(issues|pull)/<n>) — renders the full conversation as HTML.",
	matches(url) {
		return url.hostname === "github.com" && ISSUE_OR_PR.test(url.pathname);
	},
	async download(url, ctx): Promise<DownloadedRemote> {
		const args = parseIssueUrl(url);
		const page = await ctx.pool.newPage();
		try {
			// `networkidle` rarely fires on github.com (telemetry pings keep
			// the network busy). DOM-content-loaded is sufficient because
			// GitHub server-renders both the issue body and every comment
			// directly into the response HTML.
			const response = await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 30_000 });
			// Auth-required GitHub pages redirect (same-host) to
			// `github.com/login?return_to=...`; private repos the user can't
			// see 404 instead, which we surface via the response.status check
			// below.
			const finalUrl = safeResolveUrl(page.url(), url.toString());
			if (finalUrl !== null && finalUrl.hostname === "github.com" && finalUrl.pathname.startsWith("/login")) {
				throw new HelpfulError({
					kind: "auth_error",
					message: `GitHub redirected ${url.toString()} to a login page.`,
					hint: "Run `membot login` and sign into GitHub in the browser that opens, then re-run.",
				});
			}
			if (response && !response.ok() && response.status() !== 304) {
				throw new HelpfulError({
					kind: "network_error",
					message: `GitHub returned ${response.status()} for ${url.toString()}.`,
					hint: "Open the URL in your browser to verify it exists and is visible to your account.",
				});
			}
			const html = await page.content();
			const bytes = new TextEncoder().encode(html);
			return {
				bytes,
				sha256: sha256Hex(bytes),
				mimeType: "text/html",
				downloader: "github",
				downloaderArgs: args,
				sourceUrl: url.toString(),
			};
		} finally {
			await page.close().catch(() => {});
		}
	},
};

function parseIssueUrl(url: URL): Record<string, unknown> {
	const match = url.pathname.match(ISSUE_OR_PR);
	if (!match) {
		throw new HelpfulError({
			kind: "input_error",
			message: `not a GitHub issue/PR URL: ${url.toString()}`,
			hint: "Pass a URL like https://github.com/<owner>/<repo>/issues/<n> or .../pull/<n>.",
		});
	}
	return { owner: match[1], repo: match[2], kind: match[3], number: Number(match[4]) };
}
