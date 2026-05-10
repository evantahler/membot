// One-off: regenerate test/fixtures/sample.pdf.
// Run via `bun run test/fixtures/generate-sample-pdf.ts`. The output is
// committed; this script only needs to be re-run if the fixture's expected
// content changes.
import { writeFileSync } from "node:fs";
import { chromium } from "playwright";

const HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Membot PDF Fixture</title>
<style>body{font-family:Helvetica,Arial,sans-serif;padding:48px;line-height:1.5}</style>
</head><body>
<h1>Membot PDF Fixture</h1>
<p>This is a deterministic test PDF used by the converter unit tests.</p>
<p>The recognizable token <strong>FIXTURE_TOKEN_42</strong> is what tests look for.</p>
<h2>Second section</h2>
<p>A second paragraph so we exercise multi-page mergePages=false output.</p>
</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(HTML, { waitUntil: "load" });
const pdf = await page.pdf({ format: "Letter", printBackground: false });
await browser.close();
writeFileSync("test/fixtures/sample.pdf", pdf);
console.log(`wrote test/fixtures/sample.pdf (${pdf.byteLength} bytes)`);
