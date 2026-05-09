import type { ConvertersConfig, LlmConfig } from "../../config/schemas.ts";
import { logger } from "../../output/logger.ts";
import { convertImage } from "./image.ts";

/**
 * Bytes captured from an embedded image during DOCX/HTML conversion. The
 * image-inlining helpers run `convertImage` over each one to produce a
 * markdown caption that gets spliced back into the document body in place
 * of the original `<img>` reference.
 */
export interface CapturedImage {
	bytes: Uint8Array;
	mimeType: string;
	altText?: string;
}

/** URI scheme used to mark images that the inliner should expand. */
export const MEMBOT_IMG_PREFIX = "membot-img://";

/**
 * Match `![alt](membot-img://<id>)` markdown image references. The id may
 * contain any non-whitespace, non-`)` character so we don't accidentally
 * stop at characters mammoth/turndown might emit inside an id.
 */
const TOKEN_RE = /!\[([^\]]*)\]\(membot-img:\/\/([^)\s]+)\)/g;

/**
 * Extract data-URI images from raw HTML and rewrite each `<img src="data:…">`
 * to `<img src="membot-img://<id>">`. The captured bytes flow through the
 * shared `inlineImageCaptions` step so HTML and DOCX share one captioning
 * code path. Non-data `<img>` references are left untouched.
 */
export function extractDataUriImages(html: string): { html: string; images: Map<string, CapturedImage> } {
	const images = new Map<string, CapturedImage>();
	let counter = 0;
	const rewritten = html.replace(
		/<img\b([^>]*?)\bsrc\s*=\s*(?:"data:([^";]+);base64,([^"]*)"|'data:([^';]+);base64,([^']*)')([^>]*)>/gi,
		(
			_match,
			beforeSrc: string,
			mimeDouble: string | undefined,
			b64Double: string | undefined,
			mimeSingle: string | undefined,
			b64Single: string | undefined,
			afterSrc: string,
		) => {
			const mimeType = (mimeDouble ?? mimeSingle ?? "image/png").trim();
			const b64 = (b64Double ?? b64Single ?? "").replace(/\s+/g, "");
			const id = `img-${counter++}`;
			try {
				const bytes = new Uint8Array(Buffer.from(b64, "base64"));
				images.set(id, { bytes, mimeType });
			} catch (err) {
				logger.warn(
					`images-inline: failed to decode embedded image (${err instanceof Error ? err.message : String(err)})`,
				);
				return `<img${beforeSrc} src=""${afterSrc}>`;
			}
			return `<img${beforeSrc} src="${MEMBOT_IMG_PREFIX}${id}"${afterSrc}>`;
		},
	);
	return { html: rewritten, images };
}

/**
 * Replace each `![alt](membot-img://<id>)` token in `markdown` with the
 * caption produced by `convertImage`. Captures are processed in document
 * order; once `max_inline_image_captions` (from `ConvertersConfig`) has been
 * reached, the remaining tokens get a tiny deterministic placeholder rather
 * than an LLM call so a doc full of embedded images doesn't fan out into
 * hundreds of vision requests.
 *
 * No-ops on a markdown string with no `membot-img://` references; safe to
 * call unconditionally from the converters.
 */
export async function inlineImageCaptions(
	markdown: string,
	images: Map<string, CapturedImage>,
	llm: LlmConfig,
	converters: ConvertersConfig,
): Promise<string> {
	if (images.size === 0) return markdown;

	const captions = new Map<string, string>();
	const overflow = new Set<string>();
	let captioned = 0;

	for (const match of markdown.matchAll(TOKEN_RE)) {
		const alt = match[1] ?? "";
		const id = match[2];
		if (!id || captions.has(id) || overflow.has(id)) continue;
		const img = images.get(id);
		if (!img) continue;

		if (captioned >= converters.max_inline_image_captions) {
			overflow.add(id);
			continue;
		}
		captioned++;
		try {
			const caption = await convertImage(img.bytes, img.mimeType, llm);
			captions.set(id, formatCaptionBlock(alt || img.altText || "", caption));
		} catch (err) {
			logger.warn(`images-inline: caption failed for ${id} (${err instanceof Error ? err.message : String(err)})`);
			captions.set(id, formatCaptionBlock(alt || img.altText || "", `(image, ${img.mimeType}, no caption available)`));
		}
	}

	return markdown.replace(TOKEN_RE, (_match, alt: string, id: string) => {
		const cached = captions.get(id);
		if (cached) return cached;
		const img = images.get(id);
		if (!img) return formatCaptionBlock(alt, "(image, no caption available)");
		return formatCaptionBlock(
			alt || img.altText || "",
			`(image, ${img.mimeType}, ${img.bytes.byteLength} bytes — caption skipped, exceeded max_inline_image_captions)`,
		);
	});
}

/**
 * Render a captioned image as its own markdown paragraph block. Wrapping the
 * caption in blank lines guarantees the deterministic chunker sees it as a
 * paragraph boundary; an HTML comment with the alt text keeps the original
 * positional cue without polluting search snippets.
 */
function formatCaptionBlock(alt: string, caption: string): string {
	const trimmed = caption.trim();
	const header = alt.trim() ? `<!-- image: ${alt.trim()} -->` : `<!-- image -->`;
	const body = trimmed.length > 0 ? trimmed : "(image, no caption available)";
	return `\n\n${header}\n\n${body}\n\n`;
}
