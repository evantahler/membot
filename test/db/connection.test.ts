import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DbConnection } from "../../src/db/connection.ts";
import { openDb } from "../../src/db/connection.ts";

describe("openDb / connection", () => {
	let tmp: string;
	let db: DbConnection;

	beforeAll(async () => {
		tmp = mkdtempSync(join(tmpdir(), "membot-db-"));
		db = await openDb(join(tmp, "test.duckdb"));
	});

	afterAll(async () => {
		await db.close();
		rmSync(tmp, { recursive: true, force: true });
	});

	test("creates expected tables", async () => {
		const tables = await db.queryAll<{ name: string }>(
			`SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'main' ORDER BY name`,
		);
		const names = tables.map((t) => t.name);
		expect(names).toContain("blobs");
		expect(names).toContain("files");
		expect(names).toContain("chunks");
		expect(names).toContain("_migrations");
	});

	test("creates expected views", async () => {
		const views = await db.queryAll<{ name: string }>(
			`SELECT table_name AS name FROM information_schema.views WHERE table_schema = 'main' ORDER BY name`,
		);
		const names = views.map((v) => v.name);
		expect(names).toContain("current_files");
		expect(names).toContain("current_chunks");
	});

	test("queryGet returns null when no rows", async () => {
		const row = await db.queryGet(`SELECT * FROM files WHERE logical_path = ?1`, "missing");
		expect(row).toBeNull();
	});

	test("queryAll returns [] when no rows", async () => {
		const rows = await db.queryAll(`SELECT * FROM files WHERE logical_path = ?1`, "missing");
		expect(rows).toEqual([]);
	});

	test("translates ?N placeholders", async () => {
		await db.queryRun(`CREATE TEMP TABLE _kv (k TEXT, v INTEGER)`);
		await db.queryRun(`INSERT INTO _kv VALUES (?1, ?2)`, "a", 1);
		const row = await db.queryGet<{ k: string; v: number }>(`SELECT * FROM _kv WHERE k = ?1`, "a");
		expect(row).toEqual({ k: "a", v: 1 });
	});

	test("migrations are idempotent on second open", async () => {
		await db.close();
		db = await openDb(join(tmp, "test.duckdb"));
		const applied = await db.queryAll<{ id: number }>(`SELECT id FROM _migrations ORDER BY id`);
		expect(applied.map((r) => Number(r.id))).toEqual([1, 2]);
	});
});
