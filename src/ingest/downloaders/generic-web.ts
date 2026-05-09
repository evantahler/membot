import { HelpfulError } from "../../errors.ts";
import { sha256Hex } from "../local-reader.ts";
import type { DownloadedRemote, Downloader } from "./index.ts";

/**
 * Catch-all downloader. Always matches HTTP/HTTPS URLs that no
 * specific downloader claimed. Strategy:
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
 * This is what gives "no specific downloader needed" coverage to any
 * URL the user throws at `membot add`.
 */
export const genericWebDownloader: Downloader = {
	name: "generic-web",
	description:
		"Catch-all for any URL no other downloader handled — HEAD/GET, then either page.pdf() the rendered HTML or stream the raw bytes through the mime converter.",
	matches(url) {
		return url.protocol === "http:" || url.protocol === "https:";
	},
	async download(url, ctx): Promise<DownloadedRemote> {
		ctx.onProgress?.("fetching");
		const request = await ctx.pool.request();
		const response = await request.get(url.toString(), { timeout: 30_000 });
		// As the catch-all we don't know which login page each unknown
		// service redirects to. If the user lands on a rendered login
		// page, it goes through the print-to-PDF path and they'll see
		// an obviously-wrong "Sign in" PDF — the cue to run `membot login`.
		// Specific downloaders own auth-redirect detection for the services
		// they understand.
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
				const pdfBuf = await page.pdf({ format: "A4", printBackground: true, preferCSSPageSize: false });
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
};
