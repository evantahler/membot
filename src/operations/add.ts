import { z } from "zod";
import { ingest } from "../ingest/ingest.ts";
import { defineOperation } from "./types.ts";

const FetcherKindEnum = z.enum(["http", "mcpx", "local", "inline"]);

export const addOperation = defineOperation({
	name: "membot_add",
	cliName: "add",
	description: `Ingest one or many sources into the store. \`source\` accepts:
  - a local file path
  - a local directory (recursive walk, symlinks followed)
  - a glob pattern (e.g. "docs/**/*.md")
  - a URL (fetched via mcpx if configured, otherwise plain HTTP)
  - "inline:<text>" literal
PDF, DOCX, HTML, images, and other binaries are converted to markdown — native libraries first, vision/OCR for images, LLM fallback for messy or scanned input. Original bytes are kept in the blobs table; \`membot_read bytes=true\` returns them. Setting \`refresh_frequency\` enables automatic refresh from the daemon. Each ingested file becomes a NEW version under its own logical_path; existing versions stay queryable via membot_versions. Directory/glob ingests stream one file at a time — partial failures do not abort the rest; the response lists per-entry status.`,
	inputSchema: z.object({
		source: z.string().describe("Local path, directory, glob, URL, or `inline:<text>` literal"),
		logical_path: z.string().optional().describe("Destination logical_path (single source) or prefix (directory/glob)"),
		include: z.string().optional().describe("Glob include filter (comma-separated for multiple); default `**/*`"),
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
	}),
	outputSchema: z.object({
		ingested: z.array(
			z.object({
				source_path: z.string(),
				logical_path: z.string(),
				version_id: z.string().nullable(),
				status: z.enum(["ok", "failed"]),
				error: z.string().optional(),
				mime_type: z.string().nullable(),
				size_bytes: z.number(),
				fetcher: FetcherKindEnum,
				source_sha256: z.string(),
			}),
		),
		total: z.number(),
		ok: z.number(),
		failed: z.number(),
	}),
	cli: {
		positional: ["source"],
		aliases: { logical_path: "-p", refresh_frequency: "-r", change_note: "-m" },
	},
	handler: async (input, ctx) => ingest(input, ctx),
});
