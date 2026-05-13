import { HelpfulError } from "../../errors.ts";
import { sha256Hex } from "../local-reader.ts";
import { fetchWithBrowserCookies, googleLoginEntry } from "./google-shared.ts";
import { defaultUrlHint, registerSource } from "./registry.ts";
import { type BatchFetcher, type DownloadedRemote, defineSourcePlugin } from "./types.ts";

const DOC_PATH = /^\/document\/d\/([a-zA-Z0-9_-]+)/;
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

interface GoogleDocsArgs extends Record<string, unknown> {
	document_id: string;
}

/**
 * Download a Google Doc as a `.docx` blob via the canonical export
 * endpoint. Authentication uses cookies pulled from the persistent
 * chromium profile (populated by `membot login`); the fetch itself
 * is a plain Node `fetch`, not Playwright's APIRequestContext, to
 * dodge a Playwright bug that crashes parsing Set-Cookie headers
 * from Google's same-origin redirects.
 */
const googleDocsPlugin = defineSourcePlugin<Record<string, unknown>, GoogleDocsArgs>({
	name: "google-docs",
	description: "Google Docs — exports as .docx via the user's logged-in browser session.",
	examples: ["https://docs.google.com/document/d/<DOC_ID>/edit"],
	match: {
		kind: "url",
		matches: (url) => url.hostname === "docs.google.com" && DOC_PATH.test(url.pathname),
	},
	logins: [googleLoginEntry()],
	async enumerate(source, _ctx) {
		const url = new URL(source);
		const documentId = extractDocId(url);
		return [
			{
				source: url.toString(),
				logicalPathHint: defaultUrlHint(url),
				cursor: { document_id: documentId },
			},
		];
	},
	rehydrateEntry(source, args) {
		const url = new URL(source);
		return { source: url.toString(), logicalPathHint: defaultUrlHint(url), cursor: args };
	},
	async openBatchFetcher(): Promise<BatchFetcher<GoogleDocsArgs>> {
		return {
			async fetch(entry, ctx): Promise<DownloadedRemote> {
				const url = new URL(entry.source);
				const exportUrl = `https://docs.google.com/document/d/${entry.cursor.document_id}/export?format=docx`;
				const body = await fetchWithBrowserCookies(exportUrl, ctx, "Google Docs", url);
				const bytes = new Uint8Array(body);
				return {
					bytes,
					sha256: sha256Hex(body),
					mimeType: DOCX_MIME,
					downloader: "google-docs",
					downloaderArgs: { document_id: entry.cursor.document_id },
					sourceUrl: url.toString(),
				};
			},
			async close() {},
		};
	},
});

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

registerSource(googleDocsPlugin);

export { googleDocsPlugin };
