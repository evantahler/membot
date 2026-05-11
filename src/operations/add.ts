import { z } from "zod";
import { resolveEmbeddingWorkers } from "../context.ts";
import { withEmbedderPool } from "../ingest/embedder-pool.ts";
import {
	countResolvedEntries,
	type IngestCallbacks,
	type IngestEntryResult,
	type IngestResult,
	ingestResolved,
} from "../ingest/ingest.ts";
import { type ResolvedSource, resolveSource } from "../ingest/source-resolver.ts";
import { colors, formatBytes } from "../output/formatter.ts";
import { pieFor } from "../output/progress.ts";
import { isInteractive } from "../output/tty.ts";
import { defineOperation } from "./types.ts";

const FetcherKindEnum = z.enum(["downloader", "local", "inline"]);

export const addOperation = defineOperation({
	name: "membot_add",
	cliName: "add",
	description: `Ingest one or many sources into the store. Each \`sources\` arg accepts:
  - a local file path
  - a local directory (recursive walk, symlinks followed)
  - a glob pattern (e.g. "docs/**/*.md")
  - a URL (fetched via the per-service downloader registry — Google Docs/Sheets/Slides via export endpoints, GitHub + Linear as rendered HTML, anything else through a generic browser print-to-PDF fallback. All fetches authenticate via the user's logged-in browser session — run \`membot login\` once to sign in.)
  - "inline:<text>" literal
Pass any number of args; each is resolved independently and the matched entries are concatenated into one response. PDF, DOCX, HTML, images, and other binaries are converted to markdown — native libraries first, Claude vision for images, LLM fallback for messy or scanned input. Original bytes are kept in the blobs table; \`membot_read bytes=true\` returns them. Setting \`refresh_frequency\` enables automatic refresh from the daemon. By default, re-ingesting an unchanged source (same source_sha256 as the current version) is a no-op and reports \`status: "unchanged"\`; pass \`force=true\` to always create a new version. Each newly-ingested file becomes a new version under its own logical_path; existing versions stay queryable via membot_versions. Directory/glob ingests stream one file at a time — partial failures do not abort the rest; the response lists per-entry status.

When \`logical_path\` is omitted, it is derived from the source so files with the same basename in different projects do not collide:
  - Local sources use the entry's absolute filesystem path with the leading "/" stripped (e.g. "/Users/me/projA/README.md" → "Users/me/projA/README.md").
  - URLs use "remotes/{host}/{path}" with slashes preserved (e.g. "https://github.com/u/p/blob/main/README.md" → "remotes/github.com/u/p/blob/main/README.md"). Query strings and fragments are dropped from the logical_path; the full URL is still stored on the row for refresh.
  - "inline:<text>" defaults to "inline/{timestamp}.md".

Pass \`logical_path\` to override. For a multi-source / directory / glob walk it is treated as a PREFIX — each entry is placed at "{prefix}/{path-relative-to-walk-base}". Re-running \`membot_add\` on the same source resolves to the same logical_path; if bytes are unchanged the call is a no-op (status \`unchanged\`), otherwise a new version is created.`,
	inputSchema: z.object({
		sources: z
			.array(z.string())
			.min(1)
			.describe(
				"One or more sources. Each arg is independently resolved as a local path, directory, glob, URL, or `inline:<text>` literal.",
			),
		logical_path: z
			.string()
			.optional()
			.describe(
				"Destination logical_path (single source resolving to a single entry) or prefix (multi-arg / directory / glob)",
			),
		include: z
			.string()
			.optional()
			.describe(
				"Glob include filter (comma-separated for multiple). Defaults to `**/*` for directory sources, or the source pattern itself when source is a glob.",
			),
		exclude: z.string().optional().describe("Glob exclude filter (comma-separated for multiple)"),
		follow_symlinks: z
			.boolean()
			.default(true)
			.describe("Follow symlinks during directory walks (cycles broken via realpath)"),
		refresh_frequency: z.string().optional().describe("Auto-refresh cadence: 5m | 1h | 24h | 7d. Omit to disable."),
		downloader: z
			.string()
			.optional()
			.describe(
				"Force a specific downloader by name (e.g. 'google-docs', 'github', 'generic-web'). Skips URL-based matching.",
			),
		change_note: z.string().optional().describe("Free-text note attached to the new version"),
		force: z
			.boolean()
			.optional()
			.describe("Re-ingest even when source bytes are unchanged. Default skips and reports `unchanged`."),
	}),
	outputSchema: z.object({
		ingested: z.array(
			z.object({
				source_path: z.string(),
				logical_path: z.string(),
				version_id: z.string().nullable(),
				status: z.enum(["ok", "unchanged", "failed"]),
				error: z.string().optional(),
				mime_type: z.string().nullable(),
				size_bytes: z.number(),
				chunk_count: z.number().nullable(),
				fetcher: FetcherKindEnum,
				source_sha256: z.string(),
			}),
		),
		total: z.number(),
		ok: z.number(),
		unchanged: z.number(),
		failed: z.number(),
	}),
	cli: {
		positional: ["sources"],
		aliases: { logical_path: "-p", refresh_frequency: "-r", change_note: "-m", force: "-f" },
	},
	console_formatter: (result) => {
		const parts: string[] = [colors.green(`added ${result.ok}`)];
		if (result.unchanged > 0) parts.push(colors.dim(`unchanged ${result.unchanged}`));
		if (result.failed > 0) parts.push(colors.red(`failed ${result.failed}`));
		const summary = parts.join(", ");

		// In interactive mode, every entry was already streamed to stderr via
		// progress.entry() during ingest; printing the same list to stdout
		// here would just duplicate the scrollback. Non-interactive callers
		// (JSON, piped stdout, CI) don't see the live stream, so they still
		// get the full per-entry list as the operation's stdout payload.
		if (isInteractive()) return summary;

		const lines = result.ingested.map(formatEntryLine);
		return `${lines.join("\n")}\n${summary}`;
	},
	handler: async (input, ctx) => {
		const { sources, ...rest } = input;
		const followSymlinks = rest.follow_symlinks ?? true;

		// Phase 1: resolve every source upfront — outside the embedder pool
		// so we can size the pool by the actual entry count. The shared
		// progress bar also needs the total before anything starts ticking.
		// A resolve failure (bad path, glob with no base) is captured
		// per-source so one bad arg doesn't abort the whole batch.
		type ResolveOutcome = { source: string; resolved: ResolvedSource } | { source: string; error: Error };
		const outcomes: ResolveOutcome[] = [];
		for (const source of sources) {
			try {
				const resolved = await resolveSource(source, {
					include: rest.include,
					exclude: rest.exclude,
					followSymlinks,
				});
				outcomes.push({ source, resolved });
			} catch (err) {
				outcomes.push({ source, error: err instanceof Error ? err : new Error(String(err)) });
			}
		}

		const total = outcomes.reduce((n, o) => ("error" in o ? n + 1 : n + countResolvedEntries(o.resolved)), 0);

		// Spin up an ephemeral embedder pool for the whole `add` command,
		// clamped by the actual entry count: a single-file add hits the
		// `workers <= 1` inline short-circuit in withEmbedderPool and
		// avoids spawning N subprocesses (each loads ~130MB of weights).
		// `withEmbedderPool` disposes the children when the closure
		// returns; inside it, every embed() call fans out automatically.
		const configuredWorkers = resolveEmbeddingWorkers(ctx.config.embedding.workers);
		const workers = Math.max(1, Math.min(configuredWorkers, total));
		return withEmbedderPool(workers, ctx.config.embedding_model, async () => {
			const aggregated: IngestResult = {
				ingested: [],
				total: 0,
				ok: 0,
				unchanged: 0,
				failed: 0,
			};

			ctx.progress.start(total, "ingest");
			const callbacks: IngestCallbacks = {
				// Counter advances on COMPLETION so concurrent prep doesn't race the
				// bar to 100% before any file is fully persisted. The per-worker
				// status section (one line per active worker) shows file + step in
				// real time, prefixed with a pie glyph that fills as the per-file
				// pipeline progresses. `setWorkers(n)` resizes the section whenever
				// a new ingest source kicks off with its own pool size.
				onWorkerCount: (n) => ctx.progress.setWorkers(n),
				onEntryStart: (label, workerId) => {
					if (workerId !== undefined) ctx.progress.workerSet(workerId, `${pieFor(undefined)} ${label}`);
					ctx.progress.setLabel(label);
				},
				onEntryComplete: (entry, workerId) => {
					if (workerId !== undefined) ctx.progress.workerSet(workerId, "");
					ctx.progress.tick(entry.logical_path);
					ctx.progress.entry(formatEntryLine(entry));
				},
				onEntryProgress: (label, sublabel, workerId) => {
					if (workerId !== undefined) ctx.progress.workerSet(workerId, `${pieFor(sublabel)} ${label} — ${sublabel}`);
					ctx.progress.update(sublabel);
				},
				onChunks: (n) => ctx.progress.addChunks(n),
			};

			for (const outcome of outcomes) {
				if ("error" in outcome) {
					const failed: IngestEntryResult = {
						source_path: outcome.source,
						logical_path: outcome.source,
						version_id: null,
						status: "failed",
						error: outcome.error.message,
						mime_type: null,
						size_bytes: 0,
						chunk_count: null,
						fetcher: "local",
						source_sha256: "",
					};
					callbacks.onEntryStart?.(outcome.source);
					callbacks.onEntryComplete?.(failed);
					aggregated.ingested.push(failed);
					aggregated.total += 1;
					aggregated.failed += 1;
					continue;
				}

				try {
					const r = await ingestResolved(outcome.resolved, { ...rest, source: outcome.source }, ctx, callbacks);
					aggregated.ingested.push(...r.ingested);
					aggregated.total += r.total;
					aggregated.ok += r.ok;
					aggregated.unchanged += r.unchanged;
					aggregated.failed += r.failed;
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					const failed: IngestEntryResult = {
						source_path: outcome.source,
						logical_path: outcome.source,
						version_id: null,
						status: "failed",
						error: message,
						mime_type: null,
						size_bytes: 0,
						chunk_count: null,
						fetcher: "local",
						source_sha256: "",
					};
					callbacks.onEntryStart?.(outcome.source);
					callbacks.onEntryComplete?.(failed);
					aggregated.ingested.push(failed);
					aggregated.total += 1;
					aggregated.failed += 1;
				} finally {
					// Release the DB lock between sources so other consumers (a
					// concurrent CLI call, the daemon, or a separate MCP server)
					// can wedge in. The next source's first DB call reopens.
					await ctx.db.release();
				}
			}

			const summary = formatSummary(aggregated);
			ctx.progress.done(summary);
			return aggregated;
		});
	},
});

/**
 * Render the persistent stderr line shown for one completed entry. Mirrors
 * the glyphs used by the final `console_formatter` so users see the same
 * status indicators twice (once during ingest on stderr, once in the final
 * stdout summary). Successful entries show source kind, humanized byte
 * size, and chunk count so the user can spot oddly small / oddly large
 * files at a glance.
 */
function formatEntryLine(entry: IngestEntryResult): string {
	if (entry.status === "ok") {
		const parts: string[] = [entry.fetcher, formatBytes(entry.size_bytes)];
		if (entry.chunk_count !== null) {
			parts.push(`${entry.chunk_count} chunk${entry.chunk_count === 1 ? "" : "s"}`);
		}
		return `${colors.green("✓")} ${colors.cyan(entry.logical_path)} ${colors.dim(`(${parts.join(", ")})`)}`;
	}
	if (entry.status === "unchanged") {
		return `${colors.dim("≡")} ${colors.cyan(entry.logical_path)} ${colors.dim("(unchanged)")}`;
	}
	return `${colors.red("✗")} ${entry.source_path} ${colors.dim(entry.error ?? "")}`;
}

/** Compose the final spinner-success line summarising the whole batch. */
function formatSummary(r: IngestResult): string {
	const parts: string[] = [`added ${r.ok}/${r.total}`];
	if (r.unchanged > 0) parts.push(`${r.unchanged} unchanged`);
	if (r.failed > 0) parts.push(`${r.failed} failed`);
	return parts.join(", ");
}
