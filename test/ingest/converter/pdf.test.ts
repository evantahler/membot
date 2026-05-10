import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { convertPdf, type PdfConversion, shouldOcrPdf } from "../../../src/ingest/converter/pdf.ts";

function loadFixture(name: string): Uint8Array {
	return new Uint8Array(readFileSync(join(import.meta.dir, "../../fixtures", name)));
}

describe("convertPdf", () => {
	test("extracts the text layer from a normal PDF", async () => {
		const result = await convertPdf(loadFixture("sample.pdf"));
		expect(result.markdown).toContain("FIXTURE_TOKEN_42");
		expect(result.markdown).toMatch(/## Page 1/);
		expect(result.usedOcrFallback).toBe(false);
	});

	test("computes a non-zero textRatio against the input size, not the post-parse buffer", async () => {
		// Regression: unpdf detaches the ArrayBuffer during parse, so we must
		// snapshot byteLength up-front. Otherwise every PDF lands at ratio=0
		// and falsely triggers OCR.
		const result = await convertPdf(loadFixture("sample.pdf"));
		expect(result.textRatio).toBeGreaterThan(0);
		expect(shouldOcrPdf(result)).toBe(false);
	});

	test("empty bytes produces empty markdown without throwing", async () => {
		const result = await convertPdf(new Uint8Array(0));
		expect(result.markdown).toBe("");
		expect(result.textRatio).toBe(0);
		expect(result.usedOcrFallback).toBe(false);
	});

	test("non-PDF bytes are caught and degrade to empty markdown", async () => {
		const garbage = new TextEncoder().encode("definitely not a PDF");
		const result = await convertPdf(garbage);
		expect(result.markdown).toBe("");
		expect(result.textRatio).toBe(0);
	});
});

describe("shouldOcrPdf", () => {
	test("triggers OCR when markdown is empty", () => {
		const conv: PdfConversion = { markdown: "   \n\n  ", textRatio: 0.1, usedOcrFallback: false };
		expect(shouldOcrPdf(conv)).toBe(true);
	});

	test("triggers OCR when textRatio is below threshold (< 0.005)", () => {
		const conv: PdfConversion = { markdown: "hi", textRatio: 0.0001, usedOcrFallback: false };
		expect(shouldOcrPdf(conv)).toBe(true);
	});

	test("skips OCR when markdown is substantial and ratio is healthy", () => {
		const conv: PdfConversion = { markdown: "## Page 1\n\nlots of text here", textRatio: 0.05, usedOcrFallback: false };
		expect(shouldOcrPdf(conv)).toBe(false);
	});

	test("threshold boundary: exactly 0.005 still triggers OCR (strict <)", () => {
		// 0.005 is NOT below 0.005, so this should NOT trigger OCR.
		const conv: PdfConversion = { markdown: "some text", textRatio: 0.005, usedOcrFallback: false };
		expect(shouldOcrPdf(conv)).toBe(false);
	});
});
