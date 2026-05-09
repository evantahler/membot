import mammoth from "mammoth";
import TurndownService from "turndown";
import type { ConvertersConfig, LlmConfig } from "../../config/schemas.ts";
import { type CapturedImage, inlineImageCaptions, MEMBOT_IMG_PREFIX } from "./images-inline.ts";

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });

/**
 * Mammoth's image element wears an `altText` field that isn't reflected in
 * the published `.d.ts`. We declare the bits we actually touch so the rest
 * of the module can stay strict-typed.
 */
interface MammothImage {
	contentType: string;
	altText?: string;
	readAsBuffer: () => Promise<Buffer>;
}

/**
 * Convert a DOCX file to markdown. Mammoth gives us HTML; we then run that
 * through turndown to get clean markdown. Embedded images (which mammoth
 * would otherwise inline as 5MB base64 `data:` URIs) are intercepted and
 * replaced with `membot-img://<id>` placeholders, then expanded into Claude
 * vision captions by `inlineImageCaptions`. Conversion warnings from
 * mammoth are silently dropped — they're typically about styles we don't
 * preserve.
 */
export async function convertDocx(bytes: Uint8Array, llm: LlmConfig, converters: ConvertersConfig): Promise<string> {
	const buf = Buffer.from(bytes);
	const images = new Map<string, CapturedImage>();
	let counter = 0;

	const result = await mammoth.convertToHtml(
		{ buffer: buf },
		{
			convertImage: mammoth.images.imgElement(async (image) => {
				const img = image as unknown as MammothImage;
				const id = `img-${counter++}`;
				try {
					const buffer = await img.readAsBuffer();
					images.set(id, {
						bytes: new Uint8Array(buffer),
						mimeType: img.contentType,
						altText: img.altText,
					});
				} catch {
					// If we can't read the image bytes, still emit the placeholder so
					// turndown doesn't fall back to a giant inline data URI.
				}
				return { src: `${MEMBOT_IMG_PREFIX}${id}` };
			}),
		},
	);

	const md = turndown.turndown(result.value).trim();
	return inlineImageCaptions(md, images, llm, converters);
}
