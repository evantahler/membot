import { z } from "zod";
import { ingest } from "../ingest/ingest.ts";
import { colors } from "../output/formatter.ts";
import { defineOperation } from "./types.ts";

const FetcherKindEnum = z.enum(["http", "mcpx", "local", "inline"]);

export const addOperation = defineOperation({
	name: "membot_add",
	cliName: "add",
	description: `Ingest one or many sources into the store. Each \`sources\` arg accepts:
  - a local file path
  - a local directory (recursive walk, symlinks followed)
  - a glob pattern (e.g. "docs/**/*.md")
  - a URL (fetched via mcpx if configured, otherwise plain HTTP)
  - "inline:<text>" literal
Pass any number of args; each is resolved independently and the matched entries are concatenated into one response. PDF, DOCX, HTML, images, and other binaries are converted to markdown — native libraries first, vision/OCR for images, LLM fallback for messy or scanned input. Original bytes are kept in the blobs table; \`membot_read bytes=true\` returns them. Setting \`refresh_frequency\` enables automatic refresh from the daemon. By default, re-ingesting an unchanged source (same source_sha256 as the current version) is a no-op and reports \`status: "unchanged"\`; pass \`force=true\` to always create a new version. Each newly-ingested file becomes a new version under its own logical_path; existing versions stay queryable via membot_versions. Directory/glob ingests stream one file at a time — partial failures do not abort the rest; the response lists per-entry status.

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
		fetcher_hint: z
			.string()
			.optional()
			.describe("Free-form hint passed to mcpx tool search (e.g. 'firecrawl', 'github', 'google docs', 'http')"),
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
		const lines = result.ingested.map((e) => {
			if (e.status === "ok") {
				return `${colors.green("✓")} ${colors.cyan(e.logical_path)} ${colors.dim(`(${e.fetcher}, ${e.size_bytes}B)`)}`;
			}
			if (e.status === "unchanged") {
				return `${colors.dim("≡")} ${colors.cyan(e.logical_path)} ${colors.dim("(unchanged)")}`;
			}
			return `${colors.red("✗")} ${e.source_path} ${colors.dim(e.error ?? "")}`;
		});
		const parts: string[] = [colors.green(`added ${result.ok}`)];
		if (result.unchanged > 0) parts.push(colors.dim(`unchanged ${result.unchanged}`));
		if (result.failed > 0) parts.push(colors.red(`failed ${result.failed}`));
		return `${lines.join("\n")}\n${parts.join(", ")}`;
	},
	handler: async (input, ctx) => {
		const { sources, ...rest } = input;
		const aggregated = {
			ingested: [] as Awaited<ReturnType<typeof ingest>>["ingested"],
			total: 0,
			ok: 0,
			unchanged: 0,
			failed: 0,
		};
		for (const source of sources) {
			const r = await ingest({ ...rest, source }, ctx);
			aggregated.ingested.push(...r.ingested);
			aggregated.total += r.total;
			aggregated.ok += r.ok;
			aggregated.unchanged += r.unchanged;
			aggregated.failed += r.failed;
		}
		return aggregated;
	},
});
