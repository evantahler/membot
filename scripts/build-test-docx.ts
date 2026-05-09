#!/usr/bin/env bun
/**
 * One-shot generator for `test/fixtures/sample-with-image.docx`. Run this
 * (`bun scripts/build-test-docx.ts`) when the fixture is missing or when
 * the embedded test image needs to change. The DOCX itself is committed
 * to the repo so test runs don't depend on jszip-as-transitive-dep.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
// jszip ships transitively via mammoth; this script is run by hand, not in tests.
import JSZip from "../node_modules/jszip/lib/index.js";

const TINY_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
            xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
            xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
            xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
  <w:body>
    <w:p><w:r><w:t>Lead paragraph before the diagram.</w:t></w:r></w:p>
    <w:p><w:r><w:drawing>
      <wp:inline>
        <wp:extent cx="635" cy="635"/>
        <wp:docPr id="1" name="Picture 1" descr="architecture diagram"/>
        <a:graphic>
          <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
            <pic:pic>
              <pic:nvPicPr>
                <pic:cNvPr id="1" name="img.png" descr="architecture diagram"/>
                <pic:cNvPicPr/>
              </pic:nvPicPr>
              <pic:blipFill>
                <a:blip r:embed="rId1"/>
                <a:stretch><a:fillRect/></a:stretch>
              </pic:blipFill>
              <pic:spPr>
                <a:xfrm><a:off x="0" y="0"/><a:ext cx="635" cy="635"/></a:xfrm>
                <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
              </pic:spPr>
            </pic:pic>
          </a:graphicData>
        </a:graphic>
      </wp:inline>
    </w:drawing></w:r></w:p>
    <w:p><w:r><w:t>Trailing paragraph after the diagram.</w:t></w:r></w:p>
  </w:body>
</w:document>`;

const documentRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>
</Relationships>`;

const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

async function main(): Promise<void> {
	const zip = new JSZip();
	zip.file("[Content_Types].xml", contentTypes);
	zip.file("_rels/.rels", rootRels);
	zip.file("word/document.xml", documentXml);
	zip.file("word/_rels/document.xml.rels", documentRels);
	zip.file("word/media/image1.png", Buffer.from(TINY_PNG_BASE64, "base64"));

	const buffer = await zip.generateAsync({ type: "nodebuffer" });
	const out = "test/fixtures/sample-with-image.docx";
	mkdirSync(dirname(out), { recursive: true });
	writeFileSync(out, buffer);
	console.log(`wrote ${out} (${buffer.byteLength} bytes)`);
}

await main();
