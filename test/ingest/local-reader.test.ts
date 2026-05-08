import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mimeFromPath, readLocalFile, sha256Hex } from "../../src/ingest/local-reader.ts";

describe("local-reader", () => {
	let tmp: string;

	beforeAll(() => {
		tmp = mkdtempSync(join(tmpdir(), "membot-lr-"));
		writeFileSync(join(tmp, "a.md"), "hello");
	});

	afterAll(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	test("readLocalFile returns bytes, sha, mtime, size, mime", async () => {
		const r = await readLocalFile(join(tmp, "a.md"));
		expect(new TextDecoder().decode(r.bytes)).toBe("hello");
		expect(r.sizeBytes).toBe(5);
		expect(r.mimeType).toBe("text/markdown");
		expect(r.sha256).toMatch(/^[a-f0-9]{64}$/);
		expect(r.mtimeMs).toBeGreaterThan(0);
	});

	test("sha is deterministic", () => {
		const bytes = new TextEncoder().encode("hello");
		expect(sha256Hex(bytes)).toBe(sha256Hex(bytes));
		expect(sha256Hex(bytes)).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
	});

	test("mimeFromPath honors extension", () => {
		expect(mimeFromPath("/x/y/z.pdf")).toBe("application/pdf");
		expect(mimeFromPath("/x/y/z.PNG")).toBe("image/png");
		expect(mimeFromPath("/x/y/z.unknown")).toBe("application/octet-stream");
	});

	test("missing file → HelpfulError(not_found)", async () => {
		expect(readLocalFile(join(tmp, "nope"))).rejects.toMatchObject({ kind: "not_found" });
	});
});
