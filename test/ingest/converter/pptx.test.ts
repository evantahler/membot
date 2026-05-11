import { describe, expect, test } from "bun:test";
import JSZip from "jszip";
import { convertPptx } from "../../../src/ingest/converter/pptx.ts";

/**
 * Build a minimal pptx-shaped zip from the subset of files that
 * `convertPptx` actually reads. PowerPoint itself rejects this archive,
 * but the converter — which only touches `ppt/slides/slide*.xml` and
 * `ppt/notesSlides/notesSlide*.xml` — handles it just like a real pptx.
 */
async function buildPptx(files: Record<string, string>): Promise<Uint8Array> {
	const zip = new JSZip();
	for (const [path, content] of Object.entries(files)) {
		zip.file(path, content);
	}
	const buf = await zip.generateAsync({ type: "uint8array" });
	return buf;
}

function slideXml(parts: {
	title?: string;
	bullets?: string[];
	body?: string[];
	table?: string[][];
	pictureAlt?: string;
}): string {
	const shapes: string[] = [];
	if (parts.title) {
		shapes.push(`
			<p:sp>
				<p:nvSpPr><p:cNvPr id="1" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
				<p:spPr/>
				<p:txBody>
					<a:bodyPr/><a:lstStyle/>
					<a:p><a:r><a:rPr lang="en-US"/><a:t>${parts.title}</a:t></a:r></a:p>
				</p:txBody>
			</p:sp>`);
	}
	if (parts.bullets && parts.bullets.length > 0) {
		const ps = parts.bullets
			.map(
				(b, i) => `
					<a:p>
						<a:pPr lvl="${i === 0 ? 0 : 1}"><a:buChar char="•"/></a:pPr>
						<a:r><a:rPr lang="en-US"/><a:t>${b}</a:t></a:r>
					</a:p>`,
			)
			.join("");
		shapes.push(`
			<p:sp>
				<p:nvSpPr><p:cNvPr id="2" name="Body"/><p:cNvSpPr/><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr>
				<p:spPr/>
				<p:txBody><a:bodyPr/><a:lstStyle/>${ps}</p:txBody>
			</p:sp>`);
	}
	if (parts.body && parts.body.length > 0) {
		const ps = parts.body.map((b) => `<a:p><a:r><a:rPr lang="en-US"/><a:t>${b}</a:t></a:r></a:p>`).join("");
		shapes.push(`
			<p:sp>
				<p:nvSpPr><p:cNvPr id="3" name="Plain"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
				<p:spPr/>
				<p:txBody><a:bodyPr/><a:lstStyle/>${ps}</p:txBody>
			</p:sp>`);
	}
	if (parts.pictureAlt) {
		shapes.push(`
			<p:pic>
				<p:nvPicPr>
					<p:cNvPr id="9" name="Picture" descr="${parts.pictureAlt}"/>
					<p:cNvPicPr/>
					<p:nvPr/>
				</p:nvPicPr>
				<p:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>
				<p:spPr/>
			</p:pic>`);
	}
	if (parts.table) {
		const rows = parts.table
			.map(
				(row) => `
					<a:tr h="370840">
						${row
							.map(
								(cell) => `
									<a:tc>
										<a:txBody>
											<a:bodyPr/><a:lstStyle/>
											<a:p><a:r><a:rPr lang="en-US"/><a:t>${cell}</a:t></a:r></a:p>
										</a:txBody>
										<a:tcPr/>
									</a:tc>`,
							)
							.join("")}
					</a:tr>`,
			)
			.join("");
		shapes.push(`
			<p:graphicFrame>
				<p:nvGraphicFramePr><p:cNvPr id="4" name="Table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>
				<p:xfrm/>
				<a:graphic>
					<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">
						<a:tbl>
							<a:tblPr/>
							<a:tblGrid><a:gridCol w="2540000"/><a:gridCol w="2540000"/></a:tblGrid>
							${rows}
						</a:tbl>
					</a:graphicData>
				</a:graphic>
			</p:graphicFrame>`);
	}
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
       xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
       xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
	<p:cSld>
		<p:spTree>
			<p:nvGrpSpPr><p:cNvPr id="0" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
			<p:grpSpPr/>
			${shapes.join("\n")}
		</p:spTree>
	</p:cSld>
</p:sld>`;
}

describe("convertPptx", () => {
	test("returns a placeholder for an empty deck", async () => {
		const bytes = await buildPptx({});
		const md = await convertPptx(bytes);
		expect(md).toBe("(empty presentation)");
	});

	test("renders titles as ## Slide N: <title> and bullets with - markers", async () => {
		const bytes = await buildPptx({
			"ppt/slides/slide1.xml": slideXml({
				title: "FIXTURE_TOKEN_TITLE",
				bullets: ["FIXTURE_TOKEN_BULLET_A", "FIXTURE_TOKEN_BULLET_B"],
			}),
		});
		const md = await convertPptx(bytes);
		expect(md).toContain("## Slide 1: FIXTURE_TOKEN_TITLE");
		expect(md).toContain("- FIXTURE_TOKEN_BULLET_A");
		expect(md).toContain("  - FIXTURE_TOKEN_BULLET_B");
	});

	test("sorts slides numerically so slide 10 lands after slide 9", async () => {
		const files: Record<string, string> = {};
		for (let i = 1; i <= 11; i++) {
			files[`ppt/slides/slide${i}.xml`] = slideXml({ title: `Slide ${i} title` });
		}
		const md = await convertPptx(await buildPptx(files));
		const ten = md.indexOf("## Slide 10:");
		const nine = md.indexOf("## Slide 9:");
		const eleven = md.indexOf("## Slide 11:");
		expect(nine).toBeGreaterThan(0);
		expect(ten).toBeGreaterThan(nine);
		expect(eleven).toBeGreaterThan(ten);
	});

	test("renders tables as GFM pipe tables", async () => {
		const bytes = await buildPptx({
			"ppt/slides/slide1.xml": slideXml({
				title: "Table Slide",
				table: [
					["Header A", "Header B"],
					["row1a", "row1b"],
					["row2a", "row2b"],
				],
			}),
		});
		const md = await convertPptx(bytes);
		expect(md).toContain("| Header A | Header B |");
		expect(md).toContain("| --- | --- |");
		expect(md).toContain("| row1a | row1b |");
		expect(md).toContain("| row2a | row2b |");
	});

	test("falls back to first non-empty paragraph when no title placeholder exists", async () => {
		const bytes = await buildPptx({
			"ppt/slides/slide1.xml": slideXml({
				body: ["Promoted title", "Second paragraph"],
			}),
		});
		const md = await convertPptx(bytes);
		expect(md).toContain("## Slide 1: Promoted title");
		expect(md).toContain("Second paragraph");
		// Title shouldn't repeat as a body line.
		const titleMatches = md.match(/Promoted title/g) ?? [];
		expect(titleMatches.length).toBe(1);
	});

	test("renders a slide with no recoverable text as the bare heading", async () => {
		const bytes = await buildPptx({
			"ppt/slides/slide1.xml": slideXml({}),
		});
		const md = await convertPptx(bytes);
		expect(md.trim()).toBe("## Slide 1");
	});

	test("attaches non-trivial speaker notes under ### Notes", async () => {
		const bytes = await buildPptx({
			"ppt/slides/slide1.xml": slideXml({ title: "Deck Slide" }),
			"ppt/notesSlides/notesSlide1.xml": slideXml({
				body: ["FIXTURE_TOKEN_NOTE remember to mention X"],
			}),
		});
		const md = await convertPptx(bytes);
		expect(md).toContain("### Notes");
		expect(md).toContain("FIXTURE_TOKEN_NOTE remember to mention X");
	});

	test("ignores notes that only contain the slide-number footer", async () => {
		const bytes = await buildPptx({
			"ppt/slides/slide1.xml": slideXml({ title: "Deck Slide" }),
			"ppt/notesSlides/notesSlide1.xml": slideXml({ body: ["1"] }),
		});
		const md = await convertPptx(bytes);
		expect(md).not.toContain("### Notes");
	});

	test("ignores slide layouts and masters", async () => {
		const bytes = await buildPptx({
			"ppt/slides/slide1.xml": slideXml({ title: "Real Title" }),
			"ppt/slideLayouts/slideLayout1.xml": slideXml({ title: "Click to add title" }),
			"ppt/slideMasters/slideMaster1.xml": slideXml({ title: "Master placeholder" }),
		});
		const md = await convertPptx(bytes);
		expect(md).toContain("Real Title");
		expect(md).not.toContain("Click to add title");
		expect(md).not.toContain("Master placeholder");
	});

	test("emits picture alt-text (descr=) as a markdown image placeholder", async () => {
		const bytes = await buildPptx({
			"ppt/slides/slide1.xml": slideXml({
				title: "Picture Slide",
				pictureAlt: "FIXTURE_TOKEN_ALT a chart of widgets vs sprockets",
			}),
		});
		const md = await convertPptx(bytes);
		expect(md).toContain("## Slide 1: Picture Slide");
		expect(md).toContain("*Image:* FIXTURE_TOKEN_ALT a chart of widgets vs sprockets");
	});

	test("omits pictures with no alt text rather than emitting a placeholder", async () => {
		const bytes = await buildPptx({
			"ppt/slides/slide1.xml": slideXml({ title: "Bare Pic" }).replace(
				"</p:spTree>",
				`<p:pic>
					<p:nvPicPr>
						<p:cNvPr id="9" name="Picture"/>
						<p:cNvPicPr/>
						<p:nvPr/>
					</p:nvPicPr>
					<p:blipFill><a:blip r:embed="rId1"/></p:blipFill>
					<p:spPr/>
				</p:pic></p:spTree>`,
			),
		});
		const md = await convertPptx(bytes);
		expect(md).toContain("## Slide 1: Bare Pic");
		expect(md).not.toContain("*Image:*");
	});

	test("uses picture alt-text as the title when no text shape exists", async () => {
		const bytes = await buildPptx({
			"ppt/slides/slide1.xml": slideXml({
				pictureAlt: "Visual-only slide showing the architecture diagram",
			}),
		});
		const md = await convertPptx(bytes);
		// No title shape promotes to title; picture alt becomes the body line.
		// The slide heading stays bare since alt-text isn't a paragraph.
		expect(md).toContain("## Slide 1");
		expect(md).toContain("*Image:* Visual-only slide showing the architecture diagram");
	});

	test("decodes numeric character references in picture alt-text", async () => {
		// PPTX `descr=` attrs often encode newlines as &#xA; — fast-xml-parser
		// decodes named entities but leaves numeric refs alone, so we have
		// to finish the job in the converter.
		const bytes = await buildPptx({
			"ppt/slides/slide1.xml": slideXml({
				pictureAlt: "line one&#xA;line two &amp; more",
			}),
		});
		const md = await convertPptx(bytes);
		expect(md).toContain("line one\nline two & more");
		expect(md).not.toContain("&#xA;");
	});

	test("decodes XML entities in slide text", async () => {
		const bytes = await buildPptx({
			"ppt/slides/slide1.xml": slideXml({
				title: "A &amp; B &lt;C&gt;",
				body: ["10 &gt; 5 &amp;&amp; true"],
			}),
		});
		const md = await convertPptx(bytes);
		expect(md).toContain("A & B <C>");
		expect(md).toContain("10 > 5 && true");
	});
});
