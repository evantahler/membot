import { HelpfulError } from "../../errors.ts";
import { sha256Hex } from "../local-reader.ts";
import { fetchWithBrowserCookies, googleLoginEntry } from "./google-shared.ts";
import { defaultUrlHint, registerSource } from "./registry.ts";
import { type BatchFetcher, type DownloadedRemote, defineSourcePlugin } from "./types.ts";

const SLIDE_PATH = /^\/presentation\/d\/([a-zA-Z0-9_-]+)/;

interface GoogleSlidesArgs extends Record<string, unknown> {
	slides_id: string;
}

/**
 * Download a Google Slides deck as a PDF via the canonical export
 * endpoint. PDF preserves layout and text-on-slides faithfully; the
 * existing `convertPdf` pipeline (unpdf) extracts the speaker text +
 * bullets without losing slide ordering.
 */
const googleSlidesPlugin = defineSourcePlugin<Record<string, unknown>, GoogleSlidesArgs>({
	name: "google-slides",
	description: "Google Slides — exports as PDF for layout-faithful conversion.",
	examples: ["https://docs.google.com/presentation/d/<SLIDES_ID>/edit"],
	match: {
		kind: "url",
		matches: (url) => url.hostname === "docs.google.com" && SLIDE_PATH.test(url.pathname),
	},
	logins: [googleLoginEntry()],
	async enumerate(source) {
		const url = new URL(source);
		const slidesId = extractSlidesId(url);
		return [
			{
				source: url.toString(),
				logicalPathHint: defaultUrlHint(url),
				cursor: { slides_id: slidesId },
			},
		];
	},
	rehydrateEntry(source, args) {
		const url = new URL(source);
		return { source: url.toString(), logicalPathHint: defaultUrlHint(url), cursor: args };
	},
	async openBatchFetcher(): Promise<BatchFetcher<GoogleSlidesArgs>> {
		return {
			async fetch(entry, ctx): Promise<DownloadedRemote> {
				const url = new URL(entry.source);
				const exportUrl = `https://docs.google.com/presentation/d/${entry.cursor.slides_id}/export/pdf`;
				const body = await fetchWithBrowserCookies(exportUrl, ctx, "Google Slides", url);
				const bytes = new Uint8Array(body);
				return {
					bytes,
					sha256: sha256Hex(body),
					mimeType: "application/pdf",
					downloader: "google-slides",
					downloaderArgs: { slides_id: entry.cursor.slides_id },
					sourceUrl: url.toString(),
				};
			},
			async close() {},
		};
	},
});

function extractSlidesId(url: URL): string {
	const match = url.pathname.match(SLIDE_PATH);
	if (!match?.[1]) {
		throw new HelpfulError({
			kind: "input_error",
			message: `not a Google Slides URL: ${url.toString()}`,
			hint: "Pass a URL like https://docs.google.com/presentation/d/<SLIDES_ID>/edit.",
		});
	}
	return match[1];
}

registerSource(googleSlidesPlugin);

export { googleSlidesPlugin };
