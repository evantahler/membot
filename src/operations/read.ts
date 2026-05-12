import { z } from "zod";
import type { AppContext } from "../context.ts";
import { readBlob } from "../db/blobs.ts";
import { getCurrent, getVersion } from "../db/files.ts";
import { HelpfulError } from "../errors.ts";
import { normalizeLogicalPath } from "../ingest/ingest.ts";
import { colors } from "../output/formatter.ts";
import { defineOperation } from "./types.ts";

export const readOperation = defineOperation({
	name: "membot_read",
	cliName: "read",
	bashEquivalent: "cat",
	description: `Read a stored file. By default returns the cleaned markdown surrogate the rest of the index sees — for a markdown source that's the original text, for a PDF/DOCX/HTML that's the converted markdown, and for an image that's its caption. Pass bytes=true to instead return the **original ingested bytes verbatim** (base64-encoded): for a textual source like .md or .txt that's the literal source you uploaded, NOT the surrogate; for binary sources it's the raw PDF / DOCX / image bytes. Defaults to the current version; pass \`version\` (timestamp) to read a historical snapshot — use membot_versions to enumerate available versions. For finding content across many files, use membot_search instead of repeated membot_read calls.`,
	inputSchema: z.object({
		logical_path: z.string().describe("Path of the file to read"),
		version: z.string().optional().describe("Specific version_id (ISO timestamp) — defaults to current"),
		bytes: z
			.boolean()
			.default(false)
			.describe(
				"Return original ingested bytes (base64) verbatim instead of the markdown surrogate. For textual sources this is the original text, NOT the surrogate.",
			),
		offset: z.number().optional().describe("1-based start line (text mode only)"),
		limit: z.number().optional().describe("Number of lines to return (text mode only)"),
	}),
	outputSchema: z.object({
		logical_path: z.string(),
		version_id: z.string(),
		mime_type: z.string().nullable(),
		size_bytes: z.number().nullable(),
		version_is_current: z.boolean(),
		content: z.string().optional(),
		description: z.string().nullable().optional(),
		bytes_base64: z.string().optional(),
		blob_available: z.boolean(),
		bytes_skipped: z
			.boolean()
			.describe(
				"True when the blobs row exists but its bytes were intentionally not persisted (config blobs.max_size_bytes / blobs.skip_mime_types). Distinct from blob_available=false caused by an inline write (no blobs row at all).",
			),
	}),
	cli: { positional: ["logical_path"] },
	console_formatter: (result) => {
		const tag = result.version_is_current ? colors.green("[current]") : colors.yellow("[historical]");
		const head = `${colors.cyan(result.logical_path)} ${colors.dim(`@ ${result.version_id}`)} ${tag}`;
		const meta = colors.dim(
			`mime=${result.mime_type ?? "-"} size=${result.size_bytes ?? "-"} blob=${result.blob_available ? "yes" : "no"}`,
		);
		if (result.bytes_base64 !== undefined) {
			return `${head}\n${meta}\n${colors.dim(`(${result.bytes_base64.length} base64 chars; pipe with --json for the full payload)`)}`;
		}
		const body = result.content ?? "";
		return `${head}\n${meta}\n\n${body}`;
	},
	handler: async (input, ctx) => {
		const path = normalizeLogicalPath(input.logical_path);
		const cur = await getCurrent(ctx.db, path);
		const row = input.version ? await getVersion(ctx.db, path, input.version) : cur;
		if (!row) {
			throw new HelpfulError({
				kind: "not_found",
				message: `no version of ${path}${input.version ? ` at ${input.version}` : ""} found`,
				hint: `Run \`membot ls\` to see paths, or \`membot versions ${path}\` to list versions.`,
			});
		}
		const isCurrent = !!cur && cur.version_id === row.version_id;

		if (input.bytes) {
			const blob = row.blob_sha256 ? await readBlob(ctx.db, row.blob_sha256) : null;
			if (!blob) {
				throw new HelpfulError({
					kind: "not_found",
					message: `no blob row for ${path}@${row.version_id}`,
					hint: "Inline writes have no underlying blob. Use the markdown surrogate (omit bytes=true).",
				});
			}
			if (blob.bytes === null) {
				throw new HelpfulError({
					kind: "not_found",
					message: `blob bytes for ${path}@${row.version_id} were not persisted (${blob.mime_type}, ${blob.size_bytes} bytes)`,
					hint: "Bytes were skipped at ingest because the source exceeded blobs.max_size_bytes or matched blobs.skip_mime_types. Raise the limit (`membot config set blobs.max_size_bytes ...`) and re-ingest from the source to capture them, or use the markdown surrogate (omit bytes=true).",
				});
			}
			return {
				logical_path: row.logical_path,
				version_id: row.version_id,
				mime_type: blob.mime_type,
				size_bytes: blob.size_bytes,
				version_is_current: isCurrent,
				bytes_base64: Buffer.from(blob.bytes).toString("base64"),
				blob_available: true,
				bytes_skipped: false,
			};
		}

		const content = sliceLines(row.content ?? "", input.offset, input.limit);
		const blobAvailability = await checkBlobAvailability(ctx, row.blob_sha256);
		return {
			logical_path: row.logical_path,
			version_id: row.version_id,
			mime_type: row.mime_type,
			size_bytes: row.size_bytes,
			version_is_current: isCurrent,
			content,
			description: row.description,
			blob_available: blobAvailability.available,
			bytes_skipped: blobAvailability.skipped,
		};
	},
});

/**
 * Resolve the three-way state of a file's bytes: no blobs row (inline
 * write), row but `bytes IS NULL` (intentionally skipped at ingest), or
 * row with bytes (available). Cheap query — only used for the meta-only
 * read path; `bytes=true` does a full readBlob anyway.
 */
async function checkBlobAvailability(
	ctx: AppContext,
	blobSha: string | null,
): Promise<{ available: boolean; skipped: boolean }> {
	if (!blobSha) return { available: false, skipped: false };
	const row = await ctx.db.queryGet<{ has_bytes: boolean }>(
		`SELECT bytes IS NOT NULL AS has_bytes FROM blobs WHERE sha256 = ?1`,
		blobSha,
	);
	if (!row) return { available: false, skipped: false };
	return { available: row.has_bytes, skipped: !row.has_bytes };
}

/** Return the requested 1-based line range (offset..offset+limit-1) or the full body. */
function sliceLines(text: string, offset?: number, limit?: number): string {
	if (offset === undefined && limit === undefined) return text;
	const lines = text.split("\n");
	const start = Math.max(0, (offset ?? 1) - 1);
	const end = limit !== undefined ? start + limit : lines.length;
	return lines.slice(start, end).join("\n");
}
