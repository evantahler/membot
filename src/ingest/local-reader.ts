import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { asHelpful } from "../errors.ts";

export interface LocalRead {
	bytes: Uint8Array;
	sha256: string;
	mtimeMs: number;
	sizeBytes: number;
	mimeType: string;
}

/**
 * Best-effort filename → MIME mapping using Bun's built-in resolver. Strips
 * the `;charset=...` suffix Bun adds for text types so the value is safe to
 * compare with `===` against fixed MIME strings in the converter dispatch.
 * Lowercases the path's basename so `.PNG` and `.png` resolve identically.
 */
export function mimeFromPath(path: string): string {
	const lastSlash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	const base =
		lastSlash >= 0 ? path.slice(0, lastSlash + 1) + path.slice(lastSlash + 1).toLowerCase() : path.toLowerCase();
	const raw = Bun.file(base).type;
	const mime = raw.split(";")[0]?.trim();
	if (!mime || mime === "application/octet-stream") return "application/octet-stream";
	return mime;
}

/**
 * Read a local file: bytes, sha256, last-mtime, size, and an inferred MIME
 * type. Used by the ingest pipeline as the universal entry point for
 * source_type='local'.
 */
export async function readLocalFile(path: string): Promise<LocalRead> {
	let stats: Awaited<ReturnType<typeof stat>>;
	try {
		stats = await stat(path);
	} catch (err) {
		throw asHelpful(
			err,
			`while stat'ing ${path}`,
			`Check that the path exists and you have read access. \`ls -la ${path}\`.`,
			"not_found",
		);
	}
	const file = Bun.file(path);
	const ab = await file.arrayBuffer();
	const bytes = new Uint8Array(ab);
	const sha256 = sha256Hex(bytes);
	return {
		bytes,
		sha256,
		mtimeMs: stats.mtimeMs,
		sizeBytes: stats.size,
		mimeType: mimeFromPath(path),
	};
}

/** Compute a hex SHA-256 over the provided bytes. */
export function sha256Hex(bytes: Uint8Array): string {
	const hash = createHash("sha256");
	hash.update(bytes);
	return hash.digest("hex");
}
