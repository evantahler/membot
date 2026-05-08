import {
	blobValue,
	DuckDBInstance,
	type DuckDBConnection as DuckDBNativeConnection,
	type DuckDBValue,
	listValue,
} from "@duckdb/node-api";

import { EMBEDDING_DIMENSION } from "../constants.ts";
import { asHelpful } from "../errors.ts";
import { applyMigrations } from "./migrations.ts";

/** Subset of @duckdb/node-api types we feed into / get out of queries. */
export type SqlScalar = string | number | boolean | bigint | null | Uint8Array;
export type SqlParam = SqlScalar | number[] | SqlScalar[];

export interface RunResult {
	changes: number;
}

/**
 * Thin async wrapper around a DuckDB connection. Uses ?N placeholders
 * (translated to $N internally) and returns plain JS objects.
 */
export class DbConnection {
	private readonly conn: DuckDBNativeConnection;
	private readonly instance: DuckDBInstance | null;
	readonly path: string;
	private closed = false;

	constructor(conn: DuckDBNativeConnection, instance: DuckDBInstance | null, path: string) {
		this.conn = conn;
		this.instance = instance;
		this.path = path;
	}

	async exec(sql: string): Promise<void> {
		await this.conn.run(sql);
	}

	async queryGet<T extends Record<string, unknown> = Record<string, unknown>>(
		sql: string,
		...params: SqlParam[]
	): Promise<T | null> {
		const result = await this.conn.runAndReadAll(translateParams(sql), flattenParams(params) as DuckDBValue[]);
		const rows = (await result.getRowObjectsJS()) as Record<string, unknown>[];
		if (!rows[0]) return null;
		return convertRow(rows[0]) as T;
	}

	async queryAll<T extends Record<string, unknown> = Record<string, unknown>>(
		sql: string,
		...params: SqlParam[]
	): Promise<T[]> {
		const result = await this.conn.runAndReadAll(translateParams(sql), flattenParams(params) as DuckDBValue[]);
		const rows = (await result.getRowObjectsJS()) as Record<string, unknown>[];
		return rows.map(convertRow) as T[];
	}

	async queryRun(sql: string, ...params: SqlParam[]): Promise<RunResult> {
		const result = await this.conn.run(translateParams(sql), flattenParams(params) as DuckDBValue[]);
		return { changes: Number(result.rowsChanged) };
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.conn.disconnectSync();
		if (this.instance) {
			try {
				this.instance.closeSync();
			} catch {
				// best effort
			}
		}
	}
}

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

function convertRow(row: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(row)) {
		out[k] = convertValue(v);
	}
	return out;
}

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
 * Open a DuckDB-backed connection for the given file path. Runs all migrations
 * against the connection before returning. Pass `:memory:` for in-process tests.
 */
export async function openDb(path: string): Promise<DbConnection> {
	let instance: DuckDBInstance;
	try {
		instance = await DuckDBInstance.create(path);
	} catch (err) {
		throw asHelpful(
			err,
			`while opening DuckDB at ${path}`,
			`Check that ${path} is writable and not held open by another process. Delete the file to start fresh.`,
			"internal_error",
		);
	}
	const conn = await instance.connect();
	const wrapper = new DbConnection(conn, instance, path);
	await applyMigrations(wrapper);
	return wrapper;
}

export { EMBEDDING_DIMENSION };
