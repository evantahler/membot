import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DbConnection } from "../../src/db/connection.ts";
import { openDb } from "../../src/db/connection.ts";
import {
	getCurrent,
	getVersion,
	insertVersion,
	listAllCurrentPaths,
	listCurrent,
	listVersions,
	millisIso,
	pruneOldVersions,
	tombstone,
} from "../../src/db/files.ts";

describe("files CRUD", () => {
	let tmp: string;
	let db: DbConnection;

	beforeEach(async () => {
		tmp = mkdtempSync(join(tmpdir(), "membot-files-"));
		db = await openDb(join(tmp, "test.duckdb"));
	});

	afterEach(async () => {
		await db.close();
		rmSync(tmp, { recursive: true, force: true });
	});

	test("insertVersion + getCurrent roundtrip", async () => {
		const v1 = millisIso(1_700_000_000_000);
		await insertVersion(db, {
			logical_path: "docs/a.md",
			version_id: v1,
			source_type: "local",
			source_path: "/tmp/a.md",
			content: "hello",
			content_sha256: "abc",
			source_sha256: "abc",
			mime_type: "text/markdown",
			size_bytes: 5,
			fetcher: "local",
		});

		const row = await getCurrent(db, "docs/a.md");
		expect(row).not.toBeNull();
		expect(row?.content).toBe("hello");
		expect(row?.tombstone).toBe(false);
		expect(row?.fetcher).toBe("local");
	});

	test("multiple versions: current returns latest non-tombstone", async () => {
		const v1 = millisIso(1_700_000_000_000);
		const v2 = millisIso(1_700_000_001_000);
		await insertVersion(db, { logical_path: "p.md", version_id: v1, source_type: "local", content: "v1" });
		await insertVersion(db, { logical_path: "p.md", version_id: v2, source_type: "local", content: "v2" });

		const row = await getCurrent(db, "p.md");
		expect(row?.content).toBe("v2");

		const versions = await listVersions(db, "p.md");
		expect(versions).toHaveLength(2);
		expect(versions[0]?.content).toBe("v2"); // newest first
		expect(versions[1]?.content).toBe("v1");

		const v1Row = await getVersion(db, "p.md", v1);
		expect(v1Row?.content).toBe("v1");
	});

	test("tombstone hides from current_files but keeps history", async () => {
		const v1 = millisIso(1_700_000_000_000);
		await insertVersion(db, { logical_path: "p.md", version_id: v1, source_type: "local", content: "v1" });
		await tombstone(db, "p.md", "removed");

		const current = await getCurrent(db, "p.md");
		expect(current).toBeNull();

		const all = await listAllCurrentPaths(db);
		expect(all).not.toContain("p.md");

		const versions = await listVersions(db, "p.md");
		expect(versions).toHaveLength(2);
		expect(versions[0]?.tombstone).toBe(true);
	});

	test("listCurrent honors prefix filter", async () => {
		await insertVersion(db, { logical_path: "docs/a.md", source_type: "local", content: "a" });
		await insertVersion(db, { logical_path: "docs/b.md", source_type: "local", content: "b" });
		await insertVersion(db, { logical_path: "notes/c.md", source_type: "local", content: "c" });

		const docs = await listCurrent(db, { prefix: "docs/" });
		expect(docs.map((r) => r.logical_path).sort()).toEqual(["docs/a.md", "docs/b.md"]);
	});

	test("downloader_args round-trips through JSON", async () => {
		await insertVersion(db, {
			logical_path: "u.md",
			source_type: "remote",
			fetcher: "downloader",
			downloader: "google-docs",
			downloader_args: { document_id: "abc123" },
		});
		const row = await getCurrent(db, "u.md");
		expect(row?.downloader).toBe("google-docs");
		expect(row?.downloader_args).toEqual({ document_id: "abc123" });
	});

	test("pruneOldVersions keeps current, drops older non-current", async () => {
		const v1 = millisIso(1_700_000_000_000);
		const v2 = millisIso(1_700_000_001_000);
		const v3 = millisIso(1_700_000_002_000);
		await insertVersion(db, { logical_path: "p.md", version_id: v1, source_type: "local", content: "1" });
		await insertVersion(db, { logical_path: "p.md", version_id: v2, source_type: "local", content: "2" });
		await insertVersion(db, { logical_path: "p.md", version_id: v3, source_type: "local", content: "3" });

		const cutoff = millisIso(1_700_000_001_500); // between v2 and v3
		const result = await pruneOldVersions(db, cutoff);
		expect(result.removed).toBe(2); // v1 + v2 dropped, v3 (current) kept

		const versions = await listVersions(db, "p.md");
		expect(versions).toHaveLength(1);
		expect(versions[0]?.content).toBe("3");
	});
});
