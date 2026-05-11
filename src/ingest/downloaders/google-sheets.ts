import { HelpfulError } from "../../errors.ts";
import { sha256Hex } from "../local-reader.ts";
import { fetchWithBrowserCookies } from "./google-shared.ts";
import type { DownloadedRemote, Downloader } from "./index.ts";

const SHEET_PATH = /^\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/;

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/**
 * Download a Google Sheet as `.xlsx` (the workbook's native format)
 * — the export includes **every tab** in a single file. The bytes
 * flow through `convertXlsx`, which renders each tab as a markdown
 * `## <tab name>` section with a real GitHub-flavored pipe table.
 * Cleaner than the PDF route (preserves cell structure, no layout
 * truncation) and `format=html` is no longer supported by Google.
 */
export const googleSheetsDownloader: Downloader = {
	name: "google-sheets",
	description:
		"Google Sheets (docs.google.com/spreadsheets/d/<id>) — exports every tab as .xlsx, rendered to markdown tables locally.",
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
		const exportUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=xlsx`;
		const body = await fetchWithBrowserCookies(exportUrl, ctx, "Google Sheets", url);
		return {
			bytes: new Uint8Array(body),
			sha256: sha256Hex(body),
			mimeType: XLSX_MIME,
			downloader: "google-sheets",
			downloaderArgs: { sheet_id: sheetId },
			sourceUrl: url.toString(),
		};
	},
};

function extractSheetId(url: URL): string {
	const match = url.pathname.match(SHEET_PATH);
	if (!match?.[1]) {
		throw new HelpfulError({
			kind: "input_error",
			message: `not a Google Sheets URL: ${url.toString()}`,
			hint: "Pass a URL like https://docs.google.com/spreadsheets/d/<SHEET_ID>/edit.",
		});
	}
	return match[1];
}
