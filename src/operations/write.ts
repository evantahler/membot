import { z } from "zod";
import { insertChunksForVersion, rebuildFts } from "../db/chunks.ts";
import { insertVersion, millisIso } from "../db/files.ts";
import { chunkDeterministic } from "../ingest/chunker.ts";
import { describe } from "../ingest/describer.ts";
import { embed } from "../ingest/embedder.ts";
import { withEmbedderPool } from "../ingest/embedder-pool.ts";
import { parseDuration } from "../ingest/ingest.ts";
import { sha256Hex } from "../ingest/local-reader.ts";
import { buildSearchText } from "../ingest/search-text.ts";
import { colors } from "../output/formatter.ts";
import { defineOperation } from "./types.ts";

export const writeOperation = defineOperation({
	name: "membot_write",
	cliName: "write",
	bashEquivalent: "tee",
	description: `Write inline agent-authored markdown. Creates a new version (source_type='inline') under the given logical_path. Use this to persist agent notes, summaries, or synthesised context that should survive across conversations. For mirroring an external document, use membot_add with a source URL instead — that gets you refresh-on-source-change for free.`,
	inputSchema: z.object({
		logical_path: z.string().describe("Path to write to"),
		content: z.string().describe("Markdown body. CLI: pass via stdin if unspecified."),
		change_note: z.string().optional().describe("Free-text note attached to the new version"),
		refresh_frequency: z.string().optional().describe("Refresh cadence (rarely useful for inline)"),
	}),
	outputSchema: z.object({
		logical_path: z.string(),
		version_id: z.string(),
		size_bytes: z.number(),
	}),
	cli: { positional: ["logical_path"], stdinField: "content" },
	console_formatter: (result) =>
		`${colors.green("✓")} ${colors.cyan(result.logical_path)} ${colors.dim(`@ ${result.version_id}`)} ${colors.dim(`(${result.size_bytes}B)`)}`,
	handler: async (input, ctx) => {
		// `write` always handles exactly one logical_path. The embedder
		// subprocess pool can't help one document's chunks (embed() runs
		// once with N strings and the pool's win is parallelizing across
		// files, not across chunks of one file), so hard-clamp to 1 worker
		// and let withEmbedderPool take its inline short-circuit — no
		// subprocess spawn, no model-weight reload.
		return withEmbedderPool(1, ctx.config.embedding_model, async () => {
			const refreshSec = parseDuration(input.refresh_frequency);
			const bytes = new TextEncoder().encode(input.content);
			const description = await describe(input.logical_path, "text/markdown", input.content, ctx.config.llm);
			const chunks = chunkDeterministic(input.content, ctx.config.chunker);
			const searchTexts = chunks.map((c) => buildSearchText(input.logical_path, description, c.content));
			const embeddings = await embed(searchTexts, ctx.config.embedding_model);

			const versionId = millisIso(Date.now());
			const contentSha = sha256Hex(bytes);
			await insertVersion(ctx.db, {
				logical_path: input.logical_path,
				version_id: versionId,
				source_type: "inline",
				source_path: null,
				source_mtime_ms: null,
				source_sha256: contentSha,
				blob_sha256: null,
				content_sha256: contentSha,
				content: input.content,
				description,
				mime_type: "text/markdown",
				size_bytes: bytes.byteLength,
				fetcher: "inline",
				refresh_frequency_sec: refreshSec,
				refreshed_at: new Date().toISOString(),
				last_refresh_status: "ok",
				change_note: input.change_note ?? null,
			});

			await insertChunksForVersion(
				ctx.db,
				input.logical_path,
				versionId,
				chunks.map((c, i) => ({
					chunk_index: c.index,
					chunk_content: c.content,
					search_text: searchTexts[i] ?? buildSearchText(input.logical_path, description, c.content),
					embedding: embeddings[i] ?? new Array(embeddings[0]?.length ?? 0).fill(0),
				})),
			);
			await rebuildFts(ctx.db);

			return { logical_path: input.logical_path, version_id: versionId, size_bytes: bytes.byteLength };
		});
	},
});
