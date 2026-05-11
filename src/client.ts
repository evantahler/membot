import type { z } from "zod";
import { type AppContext, type BuildContextOptions, buildContext, closeContext } from "./context.ts";
import { HelpfulError } from "./errors.ts";
import { addOperation } from "./operations/add.ts";
import { diffOperation } from "./operations/diff.ts";
import { infoOperation } from "./operations/info.ts";
import { listOperation } from "./operations/list.ts";
import { moveOperation } from "./operations/move.ts";
import { pruneOperation } from "./operations/prune.ts";
import { readOperation } from "./operations/read.ts";
import { refreshOperation } from "./operations/refresh.ts";
import { removeOperation } from "./operations/remove.ts";
import { searchOperation } from "./operations/search.ts";
import { statsOperation } from "./operations/stats.ts";
import { treeOperation } from "./operations/tree.ts";
import type { Operation } from "./operations/types.ts";
import { versionsOperation } from "./operations/versions.ts";
import { writeOperation } from "./operations/write.ts";

/** Constructor options for {@link MembotClient}. */
export interface MembotClientOptions {
	/** Override config dir (defaults to ~/.membot, or $MEMBOT_HOME if set). */
	configFlag?: string;
	/**
	 * Force JSON output mode for the underlying TTY detector. Embedded callers
	 * almost always want this — leaving it false lets `ansis` emit color escapes
	 * into strings the host app may render itself. Default: `true`.
	 */
	json?: boolean;
	/** Suppress spinner / progress UI. Default: `true`. */
	noInteractive?: boolean;
	/** Strip ANSI color from any output the operations emit. Default: `true`. */
	noColor?: boolean;
	/** Forward `verbose` to the logger. Default: `false`. */
	verbose?: boolean;
}

/**
 * Programmatic entry point for membot. One method per CLI verb / MCP tool —
 * each method validates input and output through the same zod schemas the
 * commander and MCP mounts use, so behavior is identical across surfaces.
 *
 * The underlying {@link AppContext} (config + DuckDB) is built lazily on the
 * first method call. Concurrent first-calls share a single build. Call
 * {@link MembotClient.close} when done to release the DuckDB lock.
 *
 * @example
 * ```ts
 * import { MembotClient } from "membot";
 *
 * const client = new MembotClient();
 * await client.add({ sources: ["inline:hello world"], logical_path: "scratch/hello.md" });
 * const hits = await client.search({ query: "hello" });
 * await client.close();
 * ```
 */
export class MembotClient {
	private readonly options: MembotClientOptions;
	private ctx: AppContext | undefined;
	private connectPromise: Promise<AppContext> | undefined;
	private closed = false;

	constructor(options: MembotClientOptions = {}) {
		this.options = options;
	}

	/**
	 * Build the underlying {@link AppContext}. Idempotent: subsequent calls
	 * return the same context. Method calls trigger this implicitly, so
	 * calling `connect()` is only needed if you want to surface init errors
	 * (e.g. config-load failures) before issuing real work.
	 */
	async connect(): Promise<void> {
		await this.ensureContext();
	}

	/**
	 * Release the DuckDB connection and dispose the context. Idempotent;
	 * safe to call from a `finally` block. After `close()`, any further
	 * method call throws.
	 */
	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		const ctx = this.ctx;
		this.ctx = undefined;
		this.connectPromise = undefined;
		if (ctx) await closeContext(ctx);
	}

	/** Ingest one or many sources (file path, directory, glob, URL, or `inline:<text>`). */
	async add(input: z.input<typeof addOperation.inputSchema>): Promise<z.output<typeof addOperation.outputSchema>> {
		return this.run(addOperation, input);
	}

	/** List current files under an optional prefix. */
	async list(
		input: z.input<typeof listOperation.inputSchema> = {},
	): Promise<z.output<typeof listOperation.outputSchema>> {
		return this.run(listOperation, input);
	}

	/** Render the logical-path tree of the current store. */
	async tree(
		input: z.input<typeof treeOperation.inputSchema> = {},
	): Promise<z.output<typeof treeOperation.outputSchema>> {
		return this.run(treeOperation, input);
	}

	/** Read a stored file (markdown surrogate by default; `bytes: true` for original bytes). */
	async read(input: z.input<typeof readOperation.inputSchema>): Promise<z.output<typeof readOperation.outputSchema>> {
		return this.run(readOperation, input);
	}

	/** Hybrid search over the context store (semantic + BM25, fused via RRF). */
	async search(
		input: z.input<typeof searchOperation.inputSchema> = {},
	): Promise<z.output<typeof searchOperation.outputSchema>> {
		return this.run(searchOperation, input);
	}

	/** Inspect metadata for a file (source, fetcher, sha256s, refresh status). */
	async info(input: z.input<typeof infoOperation.inputSchema>): Promise<z.output<typeof infoOperation.outputSchema>> {
		return this.run(infoOperation, input);
	}

	/** Summarize the local membot index (counts, sizes, refresh health, breakdowns). */
	async stats(
		input: z.input<typeof statsOperation.inputSchema> = {},
	): Promise<z.output<typeof statsOperation.outputSchema>> {
		return this.run(statsOperation, input);
	}

	/** List every version of a file (newest first). */
	async versions(
		input: z.input<typeof versionsOperation.inputSchema>,
	): Promise<z.output<typeof versionsOperation.outputSchema>> {
		return this.run(versionsOperation, input);
	}

	/** Return a unified diff between two versions of a file. */
	async diff(input: z.input<typeof diffOperation.inputSchema>): Promise<z.output<typeof diffOperation.outputSchema>> {
		return this.run(diffOperation, input);
	}

	/** Write inline agent-authored markdown as a new version. */
	async write(
		input: z.input<typeof writeOperation.inputSchema>,
	): Promise<z.output<typeof writeOperation.outputSchema>> {
		return this.run(writeOperation, input);
	}

	/** Rename a logical_path (creates a new version under the new path; tombstones the old). */
	async move(input: z.input<typeof moveOperation.inputSchema>): Promise<z.output<typeof moveOperation.outputSchema>> {
		return this.run(moveOperation, input);
	}

	/** Tombstone one or more logical_paths (literals or globs). */
	async remove(
		input: z.input<typeof removeOperation.inputSchema>,
	): Promise<z.output<typeof removeOperation.outputSchema>> {
		return this.run(removeOperation, input);
	}

	/** Re-fetch a source (or all due sources when `logical_path` is omitted). */
	async refresh(
		input: z.input<typeof refreshOperation.inputSchema> = {},
	): Promise<z.output<typeof refreshOperation.outputSchema>> {
		return this.run(refreshOperation, input);
	}

	/** Permanently drop non-current versions older than the cutoff and GC orphan blobs. */
	async prune(
		input: z.input<typeof pruneOperation.inputSchema>,
	): Promise<z.output<typeof pruneOperation.outputSchema>> {
		return this.run(pruneOperation, input);
	}

	/**
	 * Common path: validate input → invoke handler → validate output. Mirrors
	 * the parse/handle/parse pattern in {@link ../mount/commander.ts} and
	 * {@link ../mount/mcp.ts} so all three surfaces give identical behavior.
	 */
	private async run<I extends z.ZodObject, O extends z.ZodTypeAny>(
		op: Operation<I, O>,
		raw: unknown,
	): Promise<z.output<O>> {
		const ctx = await this.ensureContext();

		const parsedInput = op.inputSchema.safeParse(raw);
		if (!parsedInput.success) {
			throw new HelpfulError({
				kind: "input_error",
				message: `invalid input to ${op.name}: ${parsedInput.error.message}`,
				hint: `Check the input shape against ${op.name}.inputSchema; common issues: missing required fields, wrong types, unknown fields.`,
				details: parsedInput.error.issues,
			});
		}

		try {
			const result = await op.handler(parsedInput.data, ctx);
			const validated = op.outputSchema.safeParse(result);
			if (!validated.success) {
				throw new HelpfulError({
					kind: "internal_error",
					message: `${op.name} produced output that doesn't match its declared schema: ${validated.error.message}`,
					hint: "This is a membot bug. Report at https://github.com/evantahler/membot/issues.",
					details: validated.error.issues,
				});
			}
			return validated.data;
		} finally {
			// Drop the DuckDB lock between calls so a concurrent CLI / daemon /
			// MCP server can claim it. The next call reopens transparently.
			try {
				await ctx.db.release();
			} catch {
				// best effort — never let release failures mask the result
			}
		}
	}

	/** Lazily build (and cache) the AppContext. Concurrent first-calls share one build. */
	private ensureContext(): Promise<AppContext> {
		if (this.closed) {
			throw new HelpfulError({
				kind: "input_error",
				message: "MembotClient is closed",
				hint: "Construct a new MembotClient instance; close() is terminal.",
			});
		}
		if (this.ctx) return Promise.resolve(this.ctx);
		if (!this.connectPromise) {
			const opts: BuildContextOptions = {
				configFlag: this.options.configFlag,
				json: this.options.json ?? true,
				noInteractive: this.options.noInteractive ?? true,
				noColor: this.options.noColor ?? true,
				verbose: this.options.verbose ?? false,
			};
			this.connectPromise = buildContext(opts).then((ctx) => {
				this.ctx = ctx;
				return ctx;
			});
		}
		return this.connectPromise;
	}
}
