import * as XLSX from "xlsx";

export interface ConvertXlsxOptions {
	/** Optional sublabel callback driven per-sheet (`parsing 3/8 tabs`). */
	onProgress?: (sublabel: string) => void;
}

/**
 * Convert an XLSX workbook into markdown — one `## <SheetName>`
 * section per tab, each tab rendered as a GitHub-flavored pipe table
 * with the first non-empty row treated as the header. Empty sheets
 * are skipped. Cell values are stringified (numbers, dates, formulas
 * use their displayed value via `XLSX.utils.format_cell`).
 *
 * Pure-JS via SheetJS — no native deps, bundles cleanly with
 * `bun build --compile`. Yields a macrotask between sheets so
 * nanospinner's setInterval keeps animating during big workbooks
 * (otherwise the spinner visibly freezes).
 */
export async function convertXlsx(bytes: Uint8Array, opts: ConvertXlsxOptions = {}): Promise<string> {
	const workbook = XLSX.read(bytes, { type: "array", cellDates: true });
	const sections: string[] = [];
	const sheetNames = workbook.SheetNames;

	for (let i = 0; i < sheetNames.length; i++) {
		const sheetName = sheetNames[i] as string;
		opts.onProgress?.(`parsing ${i + 1}/${sheetNames.length} tabs`);
		const sheet = workbook.Sheets[sheetName];
		if (sheet) {
			const rows = sheetToMatrix(sheet);
			const trimmed = trimEmptyEdges(rows);
			if (trimmed.length > 0) sections.push(`## ${sheetName}\n\n${renderTable(trimmed)}`);
		}
		// Yield so the spinner can repaint between sheets — large
		// workbooks would otherwise freeze the UI for the duration of
		// the parse.
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}

	if (sections.length === 0) return "(empty workbook)";
	return sections.join("\n\n");
}

/**
 * Walk every cell in the sheet's used range and produce a 2-D array
 * of display strings. Uses the cell's formatted text (e.g. dates as
 * "2026-05-09", percentages as "12.5%") rather than raw values, so
 * the markdown matches what a human sees in the spreadsheet.
 */
function sheetToMatrix(sheet: XLSX.WorkSheet): string[][] {
	if (!sheet["!ref"]) return [];
	const range = XLSX.utils.decode_range(sheet["!ref"]);
	const out: string[][] = [];
	for (let r = range.s.r; r <= range.e.r; r++) {
		const row: string[] = [];
		for (let c = range.s.c; c <= range.e.c; c++) {
			const addr = XLSX.utils.encode_cell({ r, c });
			const cell = sheet[addr];
			row.push(cell ? XLSX.utils.format_cell(cell) : "");
		}
		out.push(row);
	}
	return out;
}

/**
 * Drop fully-empty leading/trailing rows and columns. Spreadsheets
 * commonly have the used range padded out beyond the actual data.
 */
function trimEmptyEdges(rows: string[][]): string[][] {
	if (rows.length === 0) return rows;
	let firstRow = 0;
	let lastRow = rows.length - 1;
	while (firstRow <= lastRow && rows[firstRow]?.every((v) => v === "")) firstRow++;
	while (lastRow >= firstRow && rows[lastRow]?.every((v) => v === "")) lastRow--;
	if (firstRow > lastRow) return [];
	const sliced = rows.slice(firstRow, lastRow + 1);
	const cols = sliced[0]?.length ?? 0;
	let firstCol = 0;
	let lastCol = cols - 1;
	while (firstCol <= lastCol && sliced.every((r) => (r[firstCol] ?? "") === "")) firstCol++;
	while (lastCol >= firstCol && sliced.every((r) => (r[lastCol] ?? "") === "")) lastCol--;
	if (firstCol > lastCol) return [];
	return sliced.map((r) => r.slice(firstCol, lastCol + 1));
}

/**
 * Render a 2-D matrix as a GitHub pipe table. The first row becomes
 * the header. Pipe and newline characters in cells are escaped so
 * they don't break the table layout.
 */
function renderTable(rows: string[][]): string {
	const colCount = Math.max(...rows.map((r) => r.length));
	const norm = rows.map((r) => {
		const padded = [...r];
		while (padded.length < colCount) padded.push("");
		return padded.map(escapeCell);
	});
	const lines: string[] = [];
	const header = norm[0] ?? Array(colCount).fill("");
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
