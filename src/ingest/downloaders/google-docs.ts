import { HelpfulError } from "../../errors.ts";
import { sha256Hex } from "../local-reader.ts";
import { safeResolveUrl } from "./browser.ts";
import type { DownloadedRemote, Downloader } from "./index.ts";

const DOC_PATH = /^\/document\/d\/([a-zA-Z0-9_-]+)/;
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/**
 * Download a Google Doc as a `.docx` blob via the canonical export
 * endpoint. The user's browser cookies (saved by `membot login`) are
 * what authorize the request — no API key, no service account. The
 * resulting docx flows through the existing `convertDocx` pipeline,
 * so the markdown surrogate is identical to a docx the user uploaded
 * by hand.
 */
export const googleDocsDownloader: Downloader = {
	name: "google-docs",
	description: "Google Docs (docs.google.com/document/d/<id>) — exports as .docx via the user's logged-in session.",
	matches(url) {
		return url.hostname === "docs.google.com" && DOC_PATH.test(url.pathname);
	},
	async download(url, ctx): Promise<DownloadedRemote> {
		const docId = extractDocId(url);
		const exportUrl = `https://docs.google.com/document/d/${docId}/export?format=docx`;
		const request = await ctx.pool.request();
		const response = await request.get(exportUrl);
		const finalUrl = safeResolveUrl(response.url(), exportUrl);
		if (!response.ok() || (finalUrl !== null && finalUrl.hostname === "accounts.google.com")) {
			throw new HelpfulError({
				kind: "auth_error",
				message: `Google Docs export returned ${response.status()} for ${url.toString()}`,
				hint: "Run `membot login` and sign into Google in the browser that opens, then re-run.",
			});
		}
		const body = Buffer.from(await response.body());
		return {
			bytes: new Uint8Array(body),
			sha256: sha256Hex(body),
			mimeType: DOCX_MIME,
			downloader: "google-docs",
			downloaderArgs: { document_id: docId },
			sourceUrl: url.toString(),
		};
	},
};

function extractDocId(url: URL): string {
	const match = url.pathname.match(DOC_PATH);
	if (!match || !match[1]) {
		throw new HelpfulError({
			kind: "input_error",
			message: `not a Google Docs URL: ${url.toString()}`,
			hint: "Pass a URL like https://docs.google.com/document/d/<DOC_ID>/edit.",
		});
	}
	return match[1];
}
