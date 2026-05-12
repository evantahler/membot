/**
 * Per-segment slug used to build Apple Notes logical paths. Lower-cases,
 * replaces every non-alphanumeric run with a single `-`, trims edge dashes,
 * and caps the segment at 80 chars. An empty input becomes `untitled` so the
 * resulting path never has an empty segment.
 */
export function slugSegment(input: string): string {
	const trimmed = input.normalize("NFKD").trim();
	if (trimmed === "") return "untitled";
	const lowered = trimmed.toLowerCase();
	const dashed = lowered.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
	if (dashed === "") return "untitled";
	return dashed.length > 80 ? dashed.slice(0, 80).replace(/-+$/, "") : dashed;
}

/**
 * Slug a folder path. macos-ts returns folders as flat names today, but
 * we treat `/` in the name as a nested path separator so a future
 * "Work/Meetings" folder would land at `apple-notes/<account>/work/meetings/...`.
 */
export function slugFolderPath(folderPath: string): string {
	const parts = folderPath.split("/").map(slugSegment).filter(Boolean);
	return parts.join("/") || "untitled";
}

/**
 * Build the logical_path for an Apple Notes row. Pattern:
 *   `apple-notes/<account-slug>/<folder-path-slug>/<title-slug>.md`
 * The folder path may itself be multiple segments. Title collisions inside
 * the same folder are resolved separately by appending a short content
 * hash — that's handled by the ingest call site, not this function.
 */
export function buildAppleNotesLogicalPath(args: { accountName: string; folderPath: string; title: string }): string {
	const account = slugSegment(args.accountName);
	const folder = slugFolderPath(args.folderPath);
	const title = slugSegment(args.title);
	return `apple-notes/${account}/${folder}/${title}.md`;
}

/**
 * Append a short collision suffix derived from the note's content hash so
 * two notes with the same title in the same folder don't overwrite each
 * other. Suffix is deterministic given the same content, so a re-ingest
 * lands on the same path.
 */
export function disambiguateLogicalPath(basePath: string, contentSha256: string): string {
	const suffix = contentSha256.slice(0, 8);
	const dot = basePath.lastIndexOf(".");
	if (dot === -1) return `${basePath}-${suffix}`;
	return `${basePath.slice(0, dot)}-${suffix}${basePath.slice(dot)}`;
}
