import { HelpfulError } from "../../errors.ts";
import { sha256Hex } from "../local-reader.ts";
import { fetchWithBrowserCookies } from "./google-shared.ts";
import type { DownloadedRemote, Downloader } from "./index.ts";

const DOC_PATH = /^\/document\/d\/([a-zA-Z0-9_-]+)/;
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/**
 * Download a Google Doc as a `.docx` blob via the canonical export
 * endpoint. Authentication uses cookies pulled from the persistent
 * chromium profile (populated by `membot login`); the fetch itself
 * is a plain Node `fetch`, not Playwright's APIRequestContext, to
 * dodge a Playwright bug that crashes parsing Set-Cookie headers
 * from Google's same-origin redirects.
 */
export const googleDocsDownloader: Downloader = {
	name: "google-docs",
	description: "Google Docs (docs.google.com/document/d/<id>) — exports as .docx via the user's logged-in session.",
	logins: [
		{
			kind: "browser",
			name: "Google",
			url: "https://accounts.google.com/signin",
			description: "covers Docs, Sheets, and Slides",
		},
	],
	matches(url) {
		return url.hostname === "docs.google.com" && DOC_PATH.test(url.pathname);
	},
	async download(url, ctx): Promise<DownloadedRemote> {
		const docId = extractDocId(url);
		const exportUrl = `https://docs.google.com/document/d/${docId}/export?format=docx`;
		const body = await fetchWithBrowserCookies(exportUrl, ctx, "Google Docs", url);
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
	if (!match?.[1]) {
		throw new HelpfulError({
			kind: "input_error",
			message: `not a Google Docs URL: ${url.toString()}`,
			hint: "Pass a URL like https://docs.google.com/document/d/<DOC_ID>/edit.",
		});
	}
	return match[1];
}
