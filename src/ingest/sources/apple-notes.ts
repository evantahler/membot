import {
	APPLE_NOTES_PREFIX,
	appleNotesSourceUri,
	enumerateNotes,
	fetchNoteForRefresh,
	openAppleNotes,
	parseAppleNotesScope,
	syncTombstoneAppleNotes,
} from "../apple-notes/index.ts";
import { disambiguateLogicalPath } from "../apple-notes/logical-path.ts";
import { sha256Hex } from "../local-reader.ts";
import { registerSource } from "./registry.ts";
import { type BatchFetcher, type DownloadedRemote, defineSourcePlugin } from "./types.ts";

interface AppleNotesArgs extends Record<string, unknown> {
	noteId: number;
	accountName: string;
	folderName: string;
	title: string;
}

/**
 * Apple Notes via the macOS-native NoteStore.sqlite. Sources are
 * `apple-notes:` URIs that name a scope — `apple-notes:` is everything,
 * `apple-notes:Personal/Recipes` narrows to one folder, etc. `enumerate`
 * walks the live store and yields one Entry per matching note; `fetch`
 * decodes the gzip'd protobuf body to markdown.
 *
 * macos-only: the plugin self-skips registration on non-darwin so the
 * binary stays portable.
 */
const appleNotesPlugin = defineSourcePlugin<Record<string, unknown>, AppleNotesArgs>({
	name: "apple-notes",
	description:
		"Apple Notes (macOS) — scope-driven import via NoteStore.sqlite. Markdown comes straight from the protobuf body.",
	examples: [
		"apple-notes:",
		"apple-notes:Personal/Recipes",
		"apple-notes:*/Archive",
		"apple-notes:Personal/Recipes/**",
	],
	notes:
		"Requires Full Disk Access in System Settings → Privacy & Security for the app that launched membot (your terminal, editor, or agent app like Conductor) — then fully quit and relaunch it. Password-protected notes and Recently Deleted are skipped. Pass `--sync` to tombstone rows whose notes have been deleted.",
	match: { kind: "scheme", prefix: APPLE_NOTES_PREFIX },
	platform: ["darwin"],
	async enumerate(source, _ctx) {
		const scope = parseAppleNotesScope(source);
		const reader = openAppleNotes();
		try {
			const notes = enumerateNotes(scope, reader);
			const counts = new Map<string, number>();
			for (const n of notes) counts.set(n.defaultLogicalPath, (counts.get(n.defaultLogicalPath) ?? 0) + 1);
			return notes.map((n) => {
				const collides = (counts.get(n.defaultLogicalPath) ?? 0) > 1;
				const hint = collides
					? disambiguateLogicalPath(n.defaultLogicalPath, String(n.noteId).padStart(8, "0"))
					: n.defaultLogicalPath;
				return {
					source: appleNotesSourceUri(n.noteId),
					logicalPathHint: hint,
					mtimeMs: n.modifiedAt.getTime(),
					cursor: {
						noteId: n.noteId,
						accountName: n.accountName,
						folderName: n.folderName,
						title: n.title,
					},
				};
			});
		} finally {
			reader.close();
		}
	},
	rehydrateEntry(source, args) {
		return {
			source,
			logicalPathHint: appleNotesSourceUri(args.noteId),
			cursor: args,
		};
	},
	probeUnchanged(entry, persisted) {
		// Apple Notes bumps modifiedAt on every edit, so an exact mtime
		// match is a tight gate that costs zero protobuf decoding. When
		// it fires we skip the fetch entirely; the orchestrator does a
		// second-chance sha-based check post-fetch.
		if (entry.mtimeMs === undefined || persisted.source_mtime_ms === null) return false;
		return entry.mtimeMs === persisted.source_mtime_ms;
	},
	async openBatchFetcher(): Promise<BatchFetcher<AppleNotesArgs>> {
		const reader = openAppleNotes();
		return {
			async fetch(entry, ctx): Promise<DownloadedRemote> {
				ctx.onProgress?.("decoding note");
				const fetched = fetchNoteForRefresh(reader, entry.cursor.noteId);
				const bytes = new TextEncoder().encode(fetched.markdown);
				return {
					bytes,
					sha256: sha256Hex(bytes),
					mimeType: "text/markdown",
					downloader: "apple-notes",
					downloaderArgs: {
						noteId: fetched.noteId,
						accountName: fetched.accountName,
						folderName: fetched.folderName,
						title: fetched.title,
					},
					sourceUrl: appleNotesSourceUri(fetched.noteId),
				};
			},
			async close() {
				reader.close();
			},
		};
	},
	async sync(ctx, source) {
		const scope = parseAppleNotesScope(source);
		const reader = openAppleNotes();
		let liveIds: Set<number>;
		try {
			const notes = enumerateNotes(scope, reader);
			liveIds = new Set(notes.map((n) => n.noteId));
		} finally {
			reader.close();
		}
		return syncTombstoneAppleNotes(ctx, scope, liveIds);
	},
});

registerSource(appleNotesPlugin);

export { appleNotesPlugin };
