import { HelpfulError } from "../../errors.ts";
import { sha256Hex } from "../local-reader.ts";
import { fetchWithBrowserCookies } from "./google-shared.ts";
import type { DownloadedRemote, Downloader } from "./index.ts";

const SHEET_PATH = /^\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/;

/**
 * Download a Google Sheet as HTML (every visible tab as a `<table>`)
 * via the canonical export endpoint, then let `convertHtml` render
 * it as markdown tables. HTML is the cleanest export for retrieval —
 * `format=csv` only emits one tab and `format=xlsx` would need a new
 * converter.
 */
export const googleSheetsDownloader: Downloader = {
	name: "google-sheets",
	description: "Google Sheets (docs.google.com/spreadsheets/d/<id>) — exports every tab as HTML tables.",
	logins: [
		{
			kind: "browser",
			name: "Google",
			url: "https://accounts.google.com/signin",
			description: "covers Docs, Sheets, and Slides",
		},
	],
	matches(url) {
		return url.hostname === "docs.google.com" && SHEET_PATH.test(url.pathname);
	},
	async download(url, ctx): Promise<DownloadedRemote> {
		const sheetId = extractSheetId(url);
		const exportUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=html`;
		const body = await fetchWithBrowserCookies(exportUrl, ctx, "Google Sheets", url);
		return {
			bytes: new Uint8Array(body),
			sha256: sha256Hex(body),
			mimeType: "text/html",
			downloader: "google-sheets",
			downloaderArgs: { sheet_id: sheetId },
			sourceUrl: url.toString(),
		};
	},
};

function extractSheetId(url: URL): string {
	const match = url.pathname.match(SHEET_PATH);
	if (!match || !match[1]) {
		throw new HelpfulError({
			kind: "input_error",
			message: `not a Google Sheets URL: ${url.toString()}`,
			hint: "Pass a URL like https://docs.google.com/spreadsheets/d/<SHEET_ID>/edit.",
		});
	}
	return match[1];
}
