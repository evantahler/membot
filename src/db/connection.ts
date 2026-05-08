import {
	blobValue,
	DuckDBInstance,
	type DuckDBConnection as DuckDBNativeConnection,
	type DuckDBValue,
	listValue,
} from "@duckdb/node-api";

import { EMBEDDING_DIMENSION } from "../constants.ts";
import { asHelpful } from "../errors.ts";
import { logger } from "../output/logger.ts";
import { applyMigrations } from "./migrations.ts";

/** Subset of @duckdb/node-api types we feed into / get out of queries. */
export type SqlScalar = string | number | boolean | bigint | null | Uint8Array;
export type SqlParam = SqlScalar | number[] | SqlScalar[];

export interface RunResult {
	changes: number;
}

/** Tunables for retrying a `DuckDBInstance.create()` call when another process holds the file lock. */
export interface LockRetryOptions {
	maxAttempts: number;
	baseDelayMs: number;
	maxDelayMs: number;
}

export const DEFAULT_LOCK_RETRY: LockRetryOptions = {
	maxAttempts: 30,
	baseDelayMs: 100,
	maxDelayMs: 2000,
};

/**
 * Async wrapper around DuckDB with **lazy claim / release** semantics so
 * concurrent membot processes don't deadlock on the file lock.
 *
 * Lifecycle:
 *  - construct with a path; nothing is opened yet
 *  - first query call (`exec`/`queryGet`/`queryAll`/`queryRun`) lazily opens
 *    DuckDB, retrying with backoff on lock conflicts, and runs migrations
 *  - `release()` closes the underlying DuckDB instance but leaves the
 *    wrapper reusable — the next query reopens transparently
 *  - `close()` is permanent: subsequent queries throw
 *
 * Long-running flows (MCP server, daemon, multi-file `add`) call `release()`
 * between units of work so other consumers can grab the lock.
 */
export class DbConnection {
	readonly path: string;
	private readonly retry: LockRetryOptions;
	private conn: DuckDBNativeConnection | null = null;
	private instance: DuckDBInstance | null = null;
	private closed = false;
	private opening: Promise<void> | null = null;

	constructor(path: string, retry: LockRetryOptions = DEFAULT_LOCK_RETRY) {
		this.path = path;
		this.retry = retry;
	}

	/** Run a parameter-less SQL statement (DDL, PRAGMA, batch SQL). */
	async exec(sql: string): Promise<void> {
		const conn = await this.ensureOpen();
		await conn.run(sql);
	}

	/** Run a query and return the first row, or null. SQL uses `?N` placeholders. */
	async queryGet<T extends Record<string, unknown> = Record<string, unknown>>(
		sql: string,
		...params: SqlParam[]
	): Promise<T | null> {
		const conn = await this.ensureOpen();
		const result = await conn.runAndReadAll(translateParams(sql), flattenParams(params) as DuckDBValue[]);
		const rows = (await result.getRowObjectsJS()) as Record<string, unknown>[];
		if (!rows[0]) return null;
		return convertRow(rows[0]) as T;
	}

	/** Run a query and return all rows. SQL uses `?N` placeholders. */
	async queryAll<T extends Record<string, unknown> = Record<string, unknown>>(
		sql: string,
		...params: SqlParam[]
	): Promise<T[]> {
		const conn = await this.ensureOpen();
		const result = await conn.runAndReadAll(translateParams(sql), flattenParams(params) as DuckDBValue[]);
		const rows = (await result.getRowObjectsJS()) as Record<string, unknown>[];
		return rows.map(convertRow) as T[];
	}

	/** Run a mutation (INSERT/UPDATE/DELETE) and report rows changed. SQL uses `?N` placeholders. */
	async queryRun(sql: string, ...params: SqlParam[]): Promise<RunResult> {
		const conn = await this.ensureOpen();
		const result = await conn.run(translateParams(sql), flattenParams(params) as DuckDBValue[]);
		return { changes: Number(result.rowsChanged) };
	}

	/**
	 * Release the underlying DuckDB instance so other processes can claim
	 * the lock. The wrapper stays usable: the next query reopens. Idempotent
	 * — calling it on an already-released wrapper is a no-op.
	 */
	async release(): Promise<void> {
		if (this.closed) return;
		// If an open is in-flight, wait for it so we don't leave a stray instance behind.
		if (this.opening) {
			try {
				await this.opening;
			} catch {
				// ensureOpen already cleared state on failure
				return;
			}
		}
		this.disposeHandles();
	}

	/** Permanently close. Subsequent queries throw. */
	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		if (this.opening) {
			try {
				await this.opening;
			} catch {
				return;
			}
		}
		this.disposeHandles();
	}

	private disposeHandles(): void {
		if (this.conn) {
			try {
				this.conn.disconnectSync();
			} catch {
				// best effort
			}
			this.conn = null;
		}
		if (this.instance) {
			try {
				this.instance.closeSync();
			} catch {
				// best effort
			}
			this.instance = null;
		}
	}

	private async ensureOpen(): Promise<DuckDBNativeConnection> {
		if (this.closed) {
			throw new Error(`DbConnection at ${this.path} has been closed`);
		}
		if (this.conn) return this.conn;
		if (!this.opening) {
			this.opening = this.openOnce().finally(() => {
				this.opening = null;
			});
		}
		await this.opening;
		if (!this.conn) {
			throw new Error(`DbConnection at ${this.path} failed to open`);
		}
		return this.conn;
	}

	private async openOnce(): Promise<void> {
		const instance = await createInstanceWithRetry(this.path, this.retry);
		try {
			const conn = await instance.connect();
			this.instance = instance;
			this.conn = conn;
			await applyMigrations(this);
		} catch (err) {
			// On any failure after instance creation, release the lock immediately.
			try {
				instance.closeSync();
			} catch {
				// best effort
			}
			this.instance = null;
			this.conn = null;
			throw err;
		}
	}
}

/** True if the error message looks like DuckDB's lock-conflict shape. */
export function isLockConflictError(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : String(err ?? "");
	return /could not set lock on file|conflicting lock|database is locked/i.test(msg);
}

/** Sleep helper. */
function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run an open-the-DB factory with exponential backoff + jitter when the file
 * lock is held by another process. Non-lock errors are re-thrown immediately
 * (wrapped as `HelpfulError`) — only lock conflicts are retried. After
 * exhausting attempts we throw a `HelpfulError` whose hint names the
 * concurrent-process problem. Exposed (rather than inlined) so tests can
 * verify the retry behavior with a fake factory.
 */
export async function withLockRetry<T>(
	factory: () => Promise<T>,
	path: string,
	retry: LockRetryOptions = DEFAULT_LOCK_RETRY,
): Promise<T> {
	let lastErr: unknown;
	for (let attempt = 1; attempt <= retry.maxAttempts; attempt++) {
		try {
			return await factory();
		} catch (err) {
			lastErr = err;
			if (!isLockConflictError(err)) {
				throw asHelpful(
					err,
					`while opening DuckDB at ${path}`,
					`Check that ${path} is writable and not held open by another process. Delete the file to start fresh.`,
					"internal_error",
				);
			}
			if (attempt === retry.maxAttempts) break;
			const backoff = Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** (attempt - 1));
			const jitter = Math.floor(Math.random() * Math.min(retry.baseDelayMs, backoff));
			const wait = backoff + jitter;
			logger.debug(`db: lock held on ${path}, retrying in ${wait}ms (attempt ${attempt}/${retry.maxAttempts})`);
			await delay(wait);
		}
	}
	throw asHelpful(
		lastErr,
		`while opening DuckDB at ${path} after ${retry.maxAttempts} attempts`,
		`Another process is holding the database lock. Stop the conflicting process (check for a running 'membot serve' or open DuckDB CLI session) or delete ${path} to start fresh.`,
		"internal_error",
	);
}

/** Open a `DuckDBInstance` for `path`, retrying with backoff on lock conflicts. */
export function createInstanceWithRetry(
	path: string,
	retry: LockRetryOptions = DEFAULT_LOCK_RETRY,
): Promise<DuckDBInstance> {
	return withLockRetry(() => DuckDBInstance.create(path), path, retry);
}

/** Type guard for the JS values DuckDB returns directly without further coercion. */
function isDuckDBPrimitive(v: unknown): v is string | number | boolean | bigint | null | Uint8Array | Date {
	if (v === null) return true;
	const t = typeof v;
	return (
		t === "string" ||
		t === "number" ||
		t === "boolean" ||
		t === "bigint" ||
		v instanceof Uint8Array ||
		v instanceof Date
	);
}

/**
 * Normalize a value coming out of DuckDB into something the rest of the
 * codebase expects: `bigint` → `number` (we never have row counts that
 * exceed Number.MAX_SAFE_INTEGER), `Date` → ISO string (so JSON
 * serialization is stable), and recurse into arrays/objects.
 */
function convertValue(v: unknown): unknown {
	if (typeof v === "bigint") {
		// Bigints from row counts and TIMESTAMP fit in Number safely for our use.
		return Number(v);
	}
	if (v instanceof Date) return v.toISOString();
	if (Array.isArray(v)) return v.map(convertValue);
	if (v && typeof v === "object" && !(v instanceof Uint8Array)) {
		const out: Record<string, unknown> = {};
		for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
			out[k] = convertValue(val);
		}
		return out;
	}
	if (isDuckDBPrimitive(v)) return v;
	return v;
}

/** Apply `convertValue` to every column of a row. */
function convertRow(row: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(row)) {
		out[k] = convertValue(v);
	}
	return out;
}

/** Rewrite our `?N` placeholder convention to DuckDB's native `$N` form. */
function translateParams(sql: string): string {
	return sql.replace(/\?(\d+)/g, "$$$1");
}

/**
 * Coerce JS values into types that `@duckdb/node-api` knows how to bind.
 * Plain JS arrays and Uint8Arrays both fall through to ANY in DuckDB's
 * type-inference path, so we wrap them with the proper value classes here.
 * Use `?N::FLOAT[384]` / `?N::BLOB` SQL casts at the binding site to land
 * the value in the right column type.
 */
function flattenParams(params: SqlParam[]): unknown[] {
	return params.map((p) => {
		if (p instanceof Uint8Array) return blobValue(p);
		if (Array.isArray(p)) return listValue(p as readonly (string | number | boolean | bigint | null)[]);
		return p;
	});
}

/**
 * Construct a lazy DuckDB-backed connection for the given file path. The
 * underlying DuckDB instance isn't opened until the first query call (which
 * also runs migrations). To surface lock conflicts at the call site, callers
 * may probe with `await db.exec("SELECT 1")` immediately after construction.
 */
export async function openDb(path: string, retry: LockRetryOptions = DEFAULT_LOCK_RETRY): Promise<DbConnection> {
	const db = new DbConnection(path, retry);
	// Eager probe so initial open errors (lock conflict, bad path, migration
	// failure) surface here rather than at the first query in user code.
	await db.exec("SELECT 1");
	return db;
}

export { EMBEDDING_DIMENSION };
