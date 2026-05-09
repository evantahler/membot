import { HelpfulError } from "../../errors.ts";
import { sha256Hex } from "../local-reader.ts";
import { safeResolveUrl } from "./browser.ts";
import type { DownloadedRemote, Downloader } from "./index.ts";

const SHEET_PATH = /^\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/;

/**
 * Download a Google Sheet as HTML (every visible tab as a `<table>`)
 * via the canonical export endpoint, then let the existing
 * `convertHtml` pipeline render it as markdown tables. HTML is the
 * cleanest export for retrieval — `format=csv` only emits one tab
 * and `format=xlsx` would need a new converter.
 */
export const googleSheetsDownloader: Downloader = {
	name: "google-sheets",
	description: "Google Sheets (docs.google.com/spreadsheets/d/<id>) — exports every tab as HTML tables.",
	matches(url) {
		return url.hostname === "docs.google.com" && SHEET_PATH.test(url.pathname);
	},
	async download(url, ctx): Promise<DownloadedRemote> {
		const sheetId = extractSheetId(url);
		const exportUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=html`;
		const request = await ctx.pool.request();
		const response = await request.get(exportUrl);
		const finalUrl = safeResolveUrl(response.url(), exportUrl);
		if (!response.ok() || (finalUrl !== null && finalUrl.hostname === "accounts.google.com")) {
			throw new HelpfulError({
				kind: "auth_error",
				message: `Google Sheets export returned ${response.status()} for ${url.toString()}`,
				hint: "Run `membot login` and sign into Google in the browser that opens, then re-run.",
			});
		}
		const body = Buffer.from(await response.body());
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
