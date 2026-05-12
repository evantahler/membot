import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DbConnection, isLockConflictError, openDb, withLockRetry } from "../../src/db/connection.ts";
import { applyMigrations, forgetMigrations, type Migration } from "../../src/db/migrations.ts";
import { isHelpfulError } from "../../src/errors.ts";

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
		expect(applied.map((r) => Number(r.id))).toEqual([1, 2, 3, 4]);
	});
});

describe("DbConnection — lazy claim / release", () => {
	let tmp: string;
	let path: string;

	beforeAll(() => {
		tmp = mkdtempSync(join(tmpdir(), "membot-db-lazy-"));
		path = join(tmp, "lazy.duckdb");
	});

	afterAll(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	afterEach(() => {
		forgetMigrations(path);
	});

	test("release() then a query reopens the connection", async () => {
		const db = await openDb(path);
		await db.queryRun(`CREATE TABLE IF NOT EXISTS _kv (k TEXT, v INTEGER)`);
		await db.queryRun(`INSERT INTO _kv VALUES (?1, ?2)`, "lazy", 42);

		await db.release();
		// After release, the next query should transparently reopen the file.
		const row = await db.queryGet<{ v: number }>(`SELECT v FROM _kv WHERE k = ?1`, "lazy");
		expect(row?.v).toBe(42);

		await db.close();
	});

	test("release() is idempotent", async () => {
		const db = await openDb(path);
		await db.release();
		await db.release();
		await db.release();
		// Still usable afterwards.
		await db.queryGet(`SELECT 1`);
		await db.close();
	});

	test("close() is permanent — subsequent queries throw", async () => {
		const db = await openDb(path);
		await db.close();
		await expect(db.queryGet(`SELECT 1`)).rejects.toThrow(/closed/);
	});
});

describe("applyMigrations — transactional wrap", () => {
	let tmp: string;

	beforeAll(() => {
		tmp = mkdtempSync(join(tmpdir(), "membot-db-migr-"));
	});

	afterAll(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	test("rolls back schema changes and does not insert a _migrations row when a transactional migration fails", async () => {
		const path = join(tmp, "rollback.duckdb");
		const db = await openDb(path);
		forgetMigrations(path);

		const broken: Migration = {
			id: 999,
			name: "broken",
			statements: [
				`CREATE TABLE tx_test_tmp (x INTEGER)`,
				// Second statement deliberately invalid — should fail and trigger ROLLBACK.
				`SELECT * FROM nonexistent_table_zzz`,
			],
		};

		await expect(applyMigrations(db, [broken])).rejects.toThrow();

		// The CREATE TABLE inside the broken migration must have rolled back.
		const tables = await db.queryAll<{ name: string }>(
			`SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'main' AND table_name = 'tx_test_tmp'`,
		);
		expect(tables).toEqual([]);

		// And no _migrations row was inserted for the failing migration.
		const row = await db.queryGet(`SELECT id FROM _migrations WHERE id = ?1`, 999);
		expect(row).toBeNull();

		await db.close();
	});

	test("non-transactional migration still records its _migrations row on success", async () => {
		const path = join(tmp, "non-tx.duckdb");
		const db = await openDb(path);
		forgetMigrations(path);

		const nonTx: Migration = {
			id: 998,
			name: "non-tx",
			transactional: false,
			statements: [`CREATE TABLE non_tx_test_tmp (x INTEGER)`],
		};

		await applyMigrations(db, [nonTx]);

		const row = await db.queryGet<{ id: number }>(`SELECT id FROM _migrations WHERE id = ?1`, 998);
		expect(row?.id).toBe(998);

		await db.close();
	});
});

describe("isLockConflictError", () => {
	test("matches DuckDB's lock-conflict shapes", () => {
		expect(isLockConflictError(new Error("IO Error: Could not set lock on file foo.db"))).toBe(true);
		expect(isLockConflictError(new Error("conflicting lock is held by another process"))).toBe(true);
		expect(isLockConflictError(new Error("database is locked"))).toBe(true);
	});

	test("does not match unrelated errors", () => {
		expect(isLockConflictError(new Error("file not found"))).toBe(false);
		expect(isLockConflictError(new Error("syntax error near 'SELECT'"))).toBe(false);
		expect(isLockConflictError(null)).toBe(false);
	});
});

describe("withLockRetry", () => {
	test("retries on lock errors and ultimately succeeds", async () => {
		let calls = 0;
		const factory = async () => {
			calls += 1;
			if (calls < 3) throw new Error("IO Error: Could not set lock on file /tmp/x.duckdb");
			return "ok";
		};
		const result = await withLockRetry(factory, "/tmp/x.duckdb", {
			maxAttempts: 10,
			baseDelayMs: 5,
			maxDelayMs: 10,
		});
		expect(result).toBe("ok");
		expect(calls).toBe(3);
	});

	test("non-lock errors throw immediately as HelpfulError without retrying", async () => {
		let calls = 0;
		const factory = async () => {
			calls += 1;
			throw new Error("permission denied");
		};
		try {
			await withLockRetry(factory, "/tmp/y.duckdb", { maxAttempts: 5, baseDelayMs: 50, maxDelayMs: 50 });
			expect.unreachable("should have thrown");
		} catch (err) {
			expect(isHelpfulError(err)).toBe(true);
			expect(calls).toBe(1);
		}
	});

	test("exhausting retries throws HelpfulError naming the concurrent-process problem", async () => {
		let calls = 0;
		const factory = async () => {
			calls += 1;
			throw new Error("Could not set lock on file");
		};
		try {
			await withLockRetry(factory, "/tmp/z.duckdb", { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 });
			expect.unreachable("should have thrown");
		} catch (err) {
			expect(isHelpfulError(err)).toBe(true);
			if (isHelpfulError(err)) {
				expect(err.hint).toMatch(/Another process is holding the database lock/);
			}
			expect(calls).toBe(3);
		}
	});
});
