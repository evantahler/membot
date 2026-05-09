import { HelpfulError } from "../../errors.ts";
import { sha256Hex } from "../local-reader.ts";
import { fetchWithBrowserCookies } from "./google-shared.ts";
import type { DownloadedRemote, Downloader } from "./index.ts";

const SHEET_PATH = /^\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/;

/**
 * Download a Google Sheet as a PDF via the canonical export endpoint
 * — Google's `?format=pdf` always renders **every tab** in one
 * document (one tab per page region), which is the behavior membot
 * wants for ingest. We previously tried `?format=html` for cleaner
 * markdown tables, but Google deprecated that path and it now
 * returns 400. PDF + `convertPdf` is the reliable option; tab text
 * comes through, layout doesn't, and that's an acceptable trade-off
 * for retrieval.
 *
 * `format=csv` is a non-starter (single tab only) and `format=xlsx`
 * would need a new XLSX-to-markdown converter.
 */
export const googleSheetsDownloader: Downloader = {
	name: "google-sheets",
	description: "Google Sheets (docs.google.com/spreadsheets/d/<id>) — exports every tab as PDF.",
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
		const exportUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=pdf`;
		const body = await fetchWithBrowserCookies(exportUrl, ctx, "Google Sheets", url);
		return {
			bytes: new Uint8Array(body),
			sha256: sha256Hex(body),
			mimeType: "application/pdf",
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
