import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { convertPdf } from "../../../src/ingest/converter/pdf.ts";

function loadFixture(name: string): Uint8Array {
	return new Uint8Array(readFileSync(join(import.meta.dir, "../../fixtures", name)));
}

describe("convertPdf", () => {
	test("extracts the text layer from a normal PDF", async () => {
		const md = await convertPdf(loadFixture("sample.pdf"));
		expect(md).toContain("FIXTURE_TOKEN_42");
		expect(md).toMatch(/## Page 1/);
	});

	test("empty bytes produces empty markdown without throwing", async () => {
		const md = await convertPdf(new Uint8Array(0));
		expect(md).toBe("");
	});

	test("non-PDF bytes are caught and degrade to empty markdown", async () => {
		const garbage = new TextEncoder().encode("definitely not a PDF");
		const md = await convertPdf(garbage);
		expect(md).toBe("");
	});
});
