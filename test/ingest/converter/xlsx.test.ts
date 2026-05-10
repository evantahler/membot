import { describe, expect, test } from "bun:test";
import * as XLSX from "xlsx";
import { convertXlsx } from "../../../src/ingest/converter/xlsx.ts";

function buildWorkbook(sheets: Record<string, unknown[][]>): Uint8Array {
	const wb = XLSX.utils.book_new();
	for (const [name, rows] of Object.entries(sheets)) {
		const ws = XLSX.utils.aoa_to_sheet(rows);
		XLSX.utils.book_append_sheet(wb, ws, name);
	}
	return new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }));
}

describe("convertXlsx", () => {
	test("renders each sheet as a GFM table with the sheet name as a heading", async () => {
		const bytes = buildWorkbook({
			People: [
				["Name", "Role"],
				["Alice", "Engineer"],
				["Bob", "PM"],
			],
			Numbers: [
				["x", "y"],
				[1, 2],
			],
		});
		const md = await convertXlsx(bytes);

		expect(md).toContain("## People");
		expect(md).toContain("## Numbers");
		expect(md).toContain("| Name | Role |");
		expect(md).toContain("| --- | --- |");
		expect(md).toContain("| Alice | Engineer |");
		expect(md).toContain("| Bob | PM |");
	});

	test("escapes pipe characters inside cells", async () => {
		const bytes = buildWorkbook({
			Pipes: [
				["a", "b"],
				["one|two", "plain"],
			],
		});
		const md = await convertXlsx(bytes);
		expect(md).toContain("one\\|two");
		expect(md).not.toContain("one|two |");
	});

	test("collapses newlines in cells to spaces so the table layout is preserved", async () => {
		const bytes = buildWorkbook({
			Multi: [["col"], ["line1\nline2"]],
		});
		const md = await convertXlsx(bytes);
		expect(md).toContain("line1 line2");
		expect(md.split("\n").filter((l) => l.includes("line1")).length).toBe(1);
	});

	test("skips sheets that contain no data", async () => {
		const bytes = buildWorkbook({
			Real: [["a"], ["v"]],
			Empty: [],
		});
		const md = await convertXlsx(bytes);
		expect(md).toContain("## Real");
		expect(md).not.toContain("## Empty");
	});

	test("returns the placeholder string when every sheet is empty", async () => {
		const bytes = buildWorkbook({ Empty1: [], Empty2: [] });
		const md = await convertXlsx(bytes);
		expect(md).toBe("(empty workbook)");
	});

	test("invokes onProgress once per sheet with a 'parsing N/M tabs' label", async () => {
		const bytes = buildWorkbook({
			A: [["x"], ["1"]],
			B: [["y"], ["2"]],
			C: [["z"], ["3"]],
		});
		const labels: string[] = [];
		await convertXlsx(bytes, { onProgress: (s) => labels.push(s) });
		expect(labels).toEqual(["parsing 1/3 tabs", "parsing 2/3 tabs", "parsing 3/3 tabs"]);
	});
});
