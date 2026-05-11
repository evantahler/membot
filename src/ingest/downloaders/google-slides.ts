import { HelpfulError } from "../../errors.ts";
import { sha256Hex } from "../local-reader.ts";
import { fetchWithBrowserCookies } from "./google-shared.ts";
import type { DownloadedRemote, Downloader } from "./index.ts";

const SLIDE_PATH = /^\/presentation\/d\/([a-zA-Z0-9_-]+)/;

/**
 * Download a Google Slides deck as a PDF via the canonical export
 * endpoint. PDF preserves layout and text-on-slides faithfully; the
 * existing `convertPdf` pipeline (unpdf) extracts the speaker text +
 * bullets without losing slide ordering.
 */
export const googleSlidesDownloader: Downloader = {
	name: "google-slides",
	description: "Google Slides (docs.google.com/presentation/d/<id>) — exports as PDF for layout-faithful conversion.",
	logins: [
		{
			kind: "browser",
			name: "Google",
			url: "https://accounts.google.com/signin",
			description: "covers Docs, Sheets, and Slides",
		},
	],
	matches(url) {
		return url.hostname === "docs.google.com" && SLIDE_PATH.test(url.pathname);
	},
	async download(url, ctx): Promise<DownloadedRemote> {
		const slidesId = extractSlidesId(url);
		const exportUrl = `https://docs.google.com/presentation/d/${slidesId}/export/pdf`;
		const body = await fetchWithBrowserCookies(exportUrl, ctx, "Google Slides", url);
		return {
			bytes: new Uint8Array(body),
			sha256: sha256Hex(body),
			mimeType: "application/pdf",
			downloader: "google-slides",
			downloaderArgs: { slides_id: slidesId },
			sourceUrl: url.toString(),
		};
	},
};

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
