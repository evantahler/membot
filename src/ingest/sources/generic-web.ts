import { HelpfulError } from "../../errors.ts";
import { sha256Hex } from "../local-reader.ts";
import { defaultUrlHint, registerSource } from "./registry.ts";
import { type BatchFetcher, type DownloadedRemote, defineSourcePlugin } from "./types.ts";

interface GenericWebArgs extends Record<string, unknown> {
	rendered: boolean;
	source_content_type: string;
}

/**
 * Catch-all plugin. Always matches HTTP/HTTPS URLs that no specific
 * plugin claimed. Strategy:
 *  - Issue an authenticated GET via Playwright's request context
 *    (cookies from `membot login` flow through automatically).
 *  - If the server returned `text/html`, the page is probably a SPA
 *    or auth-gated render — open a real `page`, wait for
 *    `networkidle`, and `page.pdf()` the visible result. The rendered
 *    PDF goes through `convertPdf` so SPAs and login-walled docs
 *    work uniformly.
 *  - Otherwise the response IS the file (markdown, JSON, PDF, image,
 *    docx, …) — return its bytes verbatim and let the mime
 *    dispatcher pick the right native converter.
 *
 * Registered LAST so every more-specific URL plugin gets a chance
 * before this one swallows the request.
 */
const genericWebPlugin = defineSourcePlugin<Record<string, unknown>, GenericWebArgs>({
	name: "generic-web",
	description: "Catch-all for any other http(s) URL — HEAD/GET, render HTML via headless browser, else stream bytes.",
	examples: ["https://example.com/some-page", "https://example.com/some-file.pdf"],
	match: { kind: "url", matches: (url) => url.protocol === "http:" || url.protocol === "https:" },
	async enumerate(source, _ctx) {
		const url = new URL(source);
		return [
			{
				source: url.toString(),
				logicalPathHint: defaultUrlHint(url),
				cursor: { rendered: false, source_content_type: "" },
			},
		];
	},
	rehydrateEntry(source, args) {
		const url = new URL(source);
		return { source: url.toString(), logicalPathHint: defaultUrlHint(url), cursor: args };
	},
	async openBatchFetcher(): Promise<BatchFetcher<GenericWebArgs>> {
		return {
			async fetch(entry, ctx): Promise<DownloadedRemote> {
				const url = new URL(entry.source);
				ctx.onProgress?.("fetching");
				const request = await ctx.pool.request();
				const response = await request.get(url.toString(), { timeout: 30_000 });
				if (!response.ok() && response.status() !== 304) {
					throw new HelpfulError({
						kind: "network_error",
						message: `HTTP ${response.status()} ${response.statusText()}: ${url.toString()}`,
						hint: "Open the URL in your browser to verify it exists. For auth-gated content, run `membot login` first.",
					});
				}
				const headers = response.headers();
				const contentType =
					(headers["content-type"] ?? "application/octet-stream").split(";")[0]?.trim() ?? "application/octet-stream";

				if (contentType === "text/html" || contentType === "application/xhtml+xml") {
					const page = await ctx.pool.newPage();
					try {
						ctx.onProgress?.("rendering page");
						await page.goto(url.toString(), { waitUntil: "networkidle", timeout: 45_000 });
						ctx.onProgress?.("printing to pdf");
						const pdfBuf = await page.pdf({
							format: "A4",
							printBackground: true,
							preferCSSPageSize: false,
						});
						const bytes = new Uint8Array(pdfBuf);
						return {
							bytes,
							sha256: sha256Hex(pdfBuf),
							mimeType: "application/pdf",
							downloader: "generic-web",
							downloaderArgs: { rendered: true, source_content_type: contentType },
							sourceUrl: url.toString(),
						};
					} finally {
						await page.close().catch(() => {});
					}
				}

				const body = Buffer.from(await response.body());
				return {
					bytes: new Uint8Array(body),
					sha256: sha256Hex(body),
					mimeType: contentType,
					downloader: "generic-web",
					downloaderArgs: { rendered: false, source_content_type: contentType },
					sourceUrl: url.toString(),
				};
			},
			async close() {},
		};
	},
});

registerSource(genericWebPlugin);

export { genericWebPlugin };
