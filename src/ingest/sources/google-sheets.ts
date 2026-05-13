import { HelpfulError } from "../../errors.ts";
import { gwsExport } from "../gws.ts";
import { sha256Hex } from "../local-reader.ts";
import { googleLoginEntry } from "./google-shared.ts";
import { defaultUrlHint, registerSource } from "./registry.ts";
import { type BatchFetcher, type DownloadedRemote, defineSourcePlugin } from "./types.ts";

const SHEET_PATH = /^\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/;
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

interface GoogleSheetsArgs extends Record<string, unknown> {
	sheet_id: string;
}

/**
 * Download a Google Sheet as `.xlsx` (the workbook's native format) via
 * the bundled `gws` CLI. The export includes every tab in a single
 * file; `convertXlsx` renders each tab as a markdown `## <tab name>`
 * section with a GitHub-flavored pipe table.
 */
const googleSheetsPlugin = defineSourcePlugin<Record<string, unknown>, GoogleSheetsArgs>({
	name: "google-sheets",
	description:
		"Google Sheets — exports every tab as .xlsx via the bundled gws CLI, rendered to markdown tables locally.",
	examples: ["https://docs.google.com/spreadsheets/d/<SHEET_ID>/edit"],
	match: {
		kind: "url",
		matches: (url) => url.hostname === "docs.google.com" && SHEET_PATH.test(url.pathname),
	},
	logins: [googleLoginEntry()],
	async enumerate(source) {
		const url = new URL(source);
		const sheetId = extractSheetId(url);
		return [
			{
				source: url.toString(),
				logicalPathHint: defaultUrlHint(url),
				cursor: { sheet_id: sheetId },
			},
		];
	},
	rehydrateEntry(source, args) {
		const url = new URL(source);
		return { source: url.toString(), logicalPathHint: defaultUrlHint(url), cursor: args };
	},
	async openBatchFetcher(): Promise<BatchFetcher<GoogleSheetsArgs>> {
		return {
			async fetch(entry, ctx): Promise<DownloadedRemote> {
				const url = new URL(entry.source);
				ctx.onProgress?.("downloading from google sheets");
				const body = await gwsExport({ fileId: entry.cursor.sheet_id, mimeType: XLSX_MIME });
				const bytes = new Uint8Array(body);
				return {
					bytes,
					sha256: sha256Hex(body),
					mimeType: XLSX_MIME,
					downloader: "google-sheets",
					downloaderArgs: { sheet_id: entry.cursor.sheet_id },
					sourceUrl: url.toString(),
				};
			},
			async close() {},
		};
	},
});

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

registerSource(googleSheetsPlugin);

export { googleSheetsPlugin };
