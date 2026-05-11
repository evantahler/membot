import { XMLParser } from "fast-xml-parser";
import JSZip from "jszip";

/**
 * Preserve-order, attributes-on output. Each element parses to a single-key
 * object like `{ sld: [children], ":@": { attrs } }`. Text nodes appear as
 * `{ "#text": "..." }`. Namespace prefixes (`p:`, `a:`, `r:`) are stripped so
 * the walker doesn't need to know which schema produced each tag.
 */
const parser = new XMLParser({
	preserveOrder: true,
	ignoreAttributes: false,
	attributeNamePrefix: "",
	attributesGroupName: ":@",
	removeNSPrefix: true,
	parseAttributeValue: false,
	parseTagValue: false,
	textNodeName: "#text",
	trimValues: false,
});

type XmlNode = Record<string, unknown>;

interface Paragraph {
	text: string;
	level: number;
	isBullet: boolean;
}

interface ShapeBlock {
	kind: "shape";
	placeholder: string | null;
	paragraphs: Paragraph[];
}

interface TableBlock {
	kind: "table";
	rows: string[][];
}

interface PictureBlock {
	kind: "picture";
	altText: string;
}

type Block = ShapeBlock | TableBlock | PictureBlock;

/**
 * Convert an OOXML PowerPoint (.pptx) file into markdown. Each slide
 * becomes a `## Slide <n>: <title>` section; bullet paragraphs preserve
 * their nesting level; tables render as GFM pipe tables; pictures with
 * an accessibility `descr=` (alt-text) are surfaced as `*Image:* ...`
 * paragraphs — that text lives literally in the file. Speaker notes,
 * when present and non-trivial, appear under `### Notes`.
 *
 * Deliberately limited: image pixels, SmartArt, charts, and embedded
 * objects are not OCR'd or otherwise inferred. Their absence yields a
 * quieter markdown rather than a fabricated one — never hallucinate
 * content from a file we can't actually read.
 */
export async function convertPptx(bytes: Uint8Array): Promise<string> {
	const zip = await JSZip.loadAsync(bytes);
	const slides = await collectSlides(zip);
	if (slides.length === 0) return "(empty presentation)";

	const notesByIndex = await collectNotes(zip);
	const sections: string[] = [];

	for (const { index, xml } of slides) {
		const blocks = parseSlideBlocks(xml);
		const { title, body } = splitTitleAndBody(blocks);
		const heading = title ? `## Slide ${index}: ${title}` : `## Slide ${index}`;
		const parts = [heading];
		if (body) parts.push(body);
		const note = notesByIndex.get(index);
		if (note) parts.push(`### Notes\n\n${note}`);
		sections.push(parts.join("\n\n"));
	}

	return sections.join("\n\n---\n\n");
}

/**
 * Pull every `ppt/slides/slide<n>.xml` out of the archive, sorted by the
 * numeric suffix so slide 10 follows slide 9 (lexicographic sort would
 * land it after slide 1). Slide layouts and masters under
 * `ppt/slideLayouts/` and `ppt/slideMasters/` are intentionally ignored
 * — their placeholder text ("Click to add title") would otherwise leak in.
 */
async function collectSlides(zip: JSZip): Promise<{ index: number; xml: string }[]> {
	const out: { index: number; xml: string }[] = [];
	for (const [path, file] of Object.entries(zip.files)) {
		if (file.dir) continue;
		const m = path.match(/^ppt\/slides\/slide(\d+)\.xml$/);
		if (!m) continue;
		const xml = await file.async("string");
		out.push({ index: Number(m[1]), xml });
	}
	out.sort((a, b) => a.index - b.index);
	return out;
}

/**
 * Speaker notes live in `ppt/notesSlides/notesSlide<n>.xml` and follow the
 * same slide-relative numbering, so we map by index and only attach when
 * the note has actual content beyond the auto-generated slide-number field.
 */
async function collectNotes(zip: JSZip): Promise<Map<number, string>> {
	const byIndex = new Map<number, string>();
	for (const [path, file] of Object.entries(zip.files)) {
		if (file.dir) continue;
		const m = path.match(/^ppt\/notesSlides\/notesSlide(\d+)\.xml$/);
		if (!m) continue;
		const xml = await file.async("string");
		const blocks = parseSlideBlocks(xml);
		const text = blocks
			.flatMap((b) => (b.kind === "shape" ? b.paragraphs : []))
			.map((p) => p.text)
			.filter((t) => t.trim().length > 0 && !/^\d+$/.test(t.trim()))
			.join("\n");
		if (text.trim().length > 0) byIndex.set(Number(m[1]), text);
	}
	return byIndex;
}

/**
 * Parse a slide (or notesSlide) XML payload into an ordered list of
 * shape, table, and picture blocks, mirroring document order. Charts,
 * SmartArt diagrams, and other graphics we don't currently render are
 * silently skipped (see the module docstring for the rationale).
 */
function parseSlideBlocks(xml: string): Block[] {
	const tree = parser.parse(xml) as XmlNode[];
	const spTree = findFirst(tree, "spTree");
	if (!spTree) return [];
	const blocks: Block[] = [];
	collectBlocks(spTree, blocks);
	return blocks;
}

/**
 * Walk a spTree (or grpSp) and append every shape, table, or captioned
 * picture we find. Group shapes are flattened — their children are the
 * actual content.
 */
function collectBlocks(parent: XmlNode, out: Block[]): void {
	for (const child of getChildren(parent)) {
		const tag = getTag(child);
		if (tag === "sp") {
			out.push(parseShape(child));
		} else if (tag === "graphicFrame") {
			const table = parseGraphicFrameTable(child);
			if (table) out.push(table);
		} else if (tag === "pic") {
			const pic = parsePicture(child);
			if (pic) out.push(pic);
		} else if (tag === "grpSp") {
			collectBlocks(child, out);
		}
	}
}

/**
 * Pull the `descr` attribute off a `<p:pic>`'s `<p:cNvPr>` element. PPTX
 * accessibility metadata: the alt-text a slide author wrote for a screen
 * reader. For AI-generated decks this is often the literal image-prompt
 * — real text in the file, not a guess. Returns null when no alt text
 * exists (so a decorative image emits nothing rather than a placeholder).
 */
function parsePicture(pic: XmlNode): PictureBlock | null {
	const nvPicPr = findFirstChild(pic, "nvPicPr");
	if (!nvPicPr) return null;
	const cNvPr = findFirstChild(nvPicPr, "cNvPr");
	if (!cNvPr) return null;
	const attrs = getAttrs(cNvPr);
	const descr = decodeXmlCharRefs(attrs.descr ?? "").trim();
	if (!descr) return null;
	return { kind: "picture", altText: descr };
}

/**
 * fast-xml-parser decodes the named entities (`&amp;`, `&lt;`, ...) in
 * attribute values but leaves numeric character references like `&#xA;`
 * verbatim. PPTX `descr` attributes commonly use `&#xA;` for line breaks
 * inside multi-paragraph alt text, so we have to finish the job ourselves.
 */
function decodeXmlCharRefs(s: string): string {
	return s.replace(/&#(x[0-9a-fA-F]+|\d+);/g, (_m, code) => {
		const n = code.startsWith("x") || code.startsWith("X") ? parseInt(code.slice(1), 16) : parseInt(code, 10);
		return Number.isFinite(n) ? String.fromCodePoint(n) : _m;
	});
}

/** Read placeholder type + paragraphs from a `<sp>` shape. */
function parseShape(sp: XmlNode): ShapeBlock {
	const placeholder = findPlaceholderType(sp);
	const txBody = findFirstChild(sp, "txBody");
	const paragraphs = txBody ? extractParagraphs(txBody) : [];
	return { kind: "shape", placeholder, paragraphs };
}

/**
 * Look up `nvSpPr > nvPr > ph[type]`. Title placeholders use type=`title`
 * or `ctrTitle`; subtitles use `subTitle`; bullet bodies are `body`.
 * Returns null when the shape isn't acting as a layout placeholder.
 */
function findPlaceholderType(sp: XmlNode): string | null {
	const nvSpPr = findFirstChild(sp, "nvSpPr");
	if (!nvSpPr) return null;
	const nvPr = findFirstChild(nvSpPr, "nvPr");
	if (!nvPr) return null;
	const ph = findFirstChild(nvPr, "ph");
	if (!ph) return null;
	const attrs = getAttrs(ph);
	return attrs.type ?? "body";
}

/**
 * Walk `<a:p>` children of a `<txBody>`, concatenating `<a:t>` runs and
 * honoring `<a:br/>` as a soft line break. Indent level and whether the
 * paragraph carries a bullet marker come from `<a:pPr>`.
 */
function extractParagraphs(txBody: XmlNode): Paragraph[] {
	const out: Paragraph[] = [];
	for (const p of getChildren(txBody)) {
		if (getTag(p) !== "p") continue;
		let level = 0;
		let isBullet = false;
		const textParts: string[] = [];
		for (const node of getChildren(p)) {
			const tag = getTag(node);
			if (tag === "pPr") {
				const attrs = getAttrs(node);
				if (attrs.lvl) level = Number(attrs.lvl) || 0;
				// A <a:buChar> or <a:buAutoNum> child means this paragraph is a
				// bullet; <a:buNone> explicitly opts out. Without any marker,
				// paragraphs inside `body`/`subTitle` placeholders are bullets
				// by default — caller can refine if it cares.
				for (const sub of getChildren(node)) {
					const subTag = getTag(sub);
					if (subTag === "buChar" || subTag === "buAutoNum") isBullet = true;
					else if (subTag === "buNone") isBullet = false;
				}
				if (level > 0) isBullet = true;
			} else if (tag === "r") {
				textParts.push(extractRunText(node));
			} else if (tag === "br") {
				textParts.push("\n");
			} else if (tag === "fld") {
				// Field (slide number, date, etc.) — include its rendered text.
				textParts.push(extractRunText(node));
			}
		}
		const text = textParts
			.join("")
			.replace(/[ \t]+\n/g, "\n")
			.trim();
		out.push({ text, level, isBullet });
	}
	return out;
}

/** Concatenate every `<a:t>` text child of a run-like node. */
function extractRunText(run: XmlNode): string {
	const parts: string[] = [];
	for (const child of getChildren(run)) {
		if (getTag(child) === "t") {
			for (const leaf of getChildren(child)) {
				const t = getText(leaf);
				if (t) parts.push(t);
			}
		}
	}
	return parts.join("");
}

/**
 * Pull a `<a:tbl>` out of a `<p:graphicFrame>` wrapper and flatten it to a
 * 2-D string matrix. Returns null when the frame holds a chart, diagram,
 * or other graphic we don't currently render.
 */
function parseGraphicFrameTable(frame: XmlNode): TableBlock | null {
	const graphic = findFirstChild(frame, "graphic");
	if (!graphic) return null;
	const graphicData = findFirstChild(graphic, "graphicData");
	if (!graphicData) return null;
	const tbl = findFirstChild(graphicData, "tbl");
	if (!tbl) return null;

	const rows: string[][] = [];
	for (const row of getChildren(tbl)) {
		if (getTag(row) !== "tr") continue;
		const cells: string[] = [];
		for (const cell of getChildren(row)) {
			if (getTag(cell) !== "tc") continue;
			const txBody = findFirstChild(cell, "txBody");
			const paragraphs = txBody ? extractParagraphs(txBody) : [];
			cells.push(
				paragraphs
					.map((p) => p.text)
					.join(" ")
					.trim(),
			);
		}
		if (cells.length > 0) rows.push(cells);
	}
	if (rows.length === 0) return null;
	return { kind: "table", rows };
}

/**
 * Pick the title — first non-empty paragraph of the first title-like
 * placeholder shape, falling back to the first non-empty paragraph of
 * any shape when no title placeholder exists. The picked paragraph is
 * consumed: it won't reappear in the body.
 */
function splitTitleAndBody(blocks: Block[]): { title: string; body: string } {
	let title = "";
	let titleShapeIdx = -1;
	for (let i = 0; i < blocks.length; i++) {
		const b = blocks[i] as Block;
		if (b.kind !== "shape") continue;
		if (b.placeholder === "title" || b.placeholder === "ctrTitle") {
			const first = b.paragraphs.find((p) => p.text.trim().length > 0);
			if (first) {
				title = first.text.trim();
				titleShapeIdx = i;
				break;
			}
		}
	}
	if (!title) {
		// No title placeholder — promote the first non-empty paragraph anywhere.
		for (let i = 0; i < blocks.length; i++) {
			const b = blocks[i] as Block;
			if (b.kind !== "shape") continue;
			const first = b.paragraphs.find((p) => p.text.trim().length > 0);
			if (first) {
				title = first.text.trim();
				titleShapeIdx = i;
				// Splice the consumed paragraph out so it doesn't repeat in body.
				const idx = b.paragraphs.indexOf(first);
				b.paragraphs.splice(idx, 1);
				break;
			}
		}
	}

	const bodyParts: string[] = [];
	for (let i = 0; i < blocks.length; i++) {
		const b = blocks[i] as Block;
		if (b.kind === "shape") {
			if (i === titleShapeIdx && (b.placeholder === "title" || b.placeholder === "ctrTitle")) continue;
			const rendered = renderShape(b);
			if (rendered) bodyParts.push(rendered);
		} else if (b.kind === "table") {
			bodyParts.push(renderTable(b));
		} else if (b.kind === "picture") {
			bodyParts.push(`*Image:* ${b.altText}`);
		}
	}
	return { title, body: bodyParts.join("\n\n") };
}

/**
 * Render a shape's paragraphs as markdown. Bulleted paragraphs use `-` with
 * two-space indent per level; plain paragraphs render as one line each.
 */
function renderShape(shape: ShapeBlock): string {
	const looksLikeBulletPlaceholder = shape.placeholder === "body" || shape.placeholder === "subTitle";
	const lines: string[] = [];
	for (const p of shape.paragraphs) {
		const text = p.text.trim();
		if (!text) continue;
		const bullet = p.isBullet || (looksLikeBulletPlaceholder && shape.paragraphs.length > 1);
		if (bullet) {
			const indent = "  ".repeat(Math.max(0, p.level));
			// Multi-line bullet text (from <a:br/>) gets folded into a single
			// line — pptx soft breaks rarely carry semantic weight in a deck.
			lines.push(`${indent}- ${text.replace(/\n+/g, " ")}`);
		} else {
			lines.push(text);
		}
	}
	return lines.join("\n");
}

/**
 * Render a 2-D table as a GFM pipe table. First row is the header. Pipe
 * and newline characters in cells are escaped so they don't break layout.
 * Mirrors the shape of xlsx.ts's renderTable.
 */
function renderTable(table: TableBlock): string {
	const colCount = Math.max(...table.rows.map((r) => r.length));
	const norm = table.rows.map((r) => {
		const padded = [...r];
		while (padded.length < colCount) padded.push("");
		return padded.map(escapeCell);
	});
	const header = norm[0] ?? Array(colCount).fill("");
	const lines: string[] = [];
	lines.push(`| ${header.join(" | ")} |`);
	lines.push(`| ${Array(colCount).fill("---").join(" | ")} |`);
	for (let i = 1; i < norm.length; i++) {
		lines.push(`| ${(norm[i] as string[]).join(" | ")} |`);
	}
	return lines.join("\n");
}

function escapeCell(value: string): string {
	return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/** Find the first occurrence of `tag` anywhere in the subtree (depth-first). */
function findFirst(forest: XmlNode[], tag: string): XmlNode | null {
	for (const node of forest) {
		if (getTag(node) === tag) return node;
		const found = findFirst(getChildren(node), tag);
		if (found) return found;
	}
	return null;
}

/** Find the first direct child matching `tag`. */
function findFirstChild(node: XmlNode, tag: string): XmlNode | null {
	for (const child of getChildren(node)) {
		if (getTag(child) === tag) return child;
	}
	return null;
}

function getTag(node: XmlNode): string {
	for (const k of Object.keys(node)) {
		if (k !== ":@" && k !== "#text") return k;
	}
	return "";
}

function getChildren(node: XmlNode): XmlNode[] {
	const tag = getTag(node);
	const v = node[tag];
	return Array.isArray(v) ? (v as XmlNode[]) : [];
}

function getAttrs(node: XmlNode): Record<string, string> {
	const a = node[":@"];
	return (a as Record<string, string>) ?? {};
}

function getText(node: XmlNode): string | null {
	const t = node["#text"];
	if (typeof t === "string") return t;
	if (typeof t === "number") return String(t);
	return null;
}
