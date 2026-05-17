import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MembotConfigSchema } from "../../../src/config/schemas.ts";
import type { AppContext } from "../../../src/context.ts";
import { closeContext } from "../../../src/context.ts";
import { openDb } from "../../../src/db/connection.ts";
import { getCurrent, insertVersion } from "../../../src/db/files.ts";
import type {
	AppleNotesAccount,
	AppleNotesContent,
	AppleNotesFolder,
	AppleNotesMeta,
	AppleNotesReader,
} from "../../../src/ingest/apple-notes/reader.ts";
import { setEmbeddingCacheDir } from "../../../src/ingest/embedder.ts";
import "../../../src/ingest/sources/index.ts";
import { addOperation } from "../../../src/operations/add.ts";
import { logger } from "../../../src/output/logger.ts";
import { createProgress } from "../../../src/output/progress.ts";

interface FakeNote {
	id: number;
	title: string;
	folderName: string;
	accountName: string;
	modifiedAt: Date;
	body?: string;
}

interface FakeReaderHandle {
	reader: AppleNotesReader;
	readCount: () => number;
	resetReadCount: () => void;
}

/**
 * Build an in-memory AppleNotesReader that mirrors the production-shaped
 * data the plugin consumes. Counts `readNote()` calls so tests can prove
 * the cheap pre-fetch gate skipped the protobuf decode.
 */
function buildFakeReader(notes: FakeNote[]): FakeReaderHandle {
	const accountsByName = new Map<string, AppleNotesAccount>();
	const foldersByKey = new Map<string, AppleNotesFolder>();
	let nextAccountId = 1;
	let nextFolderId = 1;
	for (const n of notes) {
		if (!accountsByName.has(n.accountName)) {
			accountsByName.set(n.accountName, { id: nextAccountId++, name: n.accountName });
		}
		const key = `${n.accountName}::${n.folderName}`;
		if (!foldersByKey.has(key)) {
			const account = accountsByName.get(n.accountName);
			if (!account) throw new Error("unreachable");
			foldersByKey.set(key, {
				id: nextFolderId++,
				name: n.folderName,
				accountId: account.id,
				accountName: account.name,
				noteCount: 0,
			});
		}
		const f = foldersByKey.get(key);
		if (!f) throw new Error("unreachable");
		f.noteCount += 1;
	}
	let readCount = 0;
	const reader: AppleNotesReader = {
		listAccounts: () => [...accountsByName.values()],
		listFolders: (accountName) => {
			const all = [...foldersByKey.values()];
			return accountName ? all.filter((f) => f.accountName === accountName) : all;
		},
		listNotesIn: (accountName, folderName) =>
			notes
				.filter((n) => {
					if (n.folderName !== folderName) return false;
					return accountName === "" ? true : n.accountName === accountName;
				})
				.map<AppleNotesMeta>((n) => ({
					id: n.id,
					title: n.title,
					folderName: n.folderName,
					accountName: n.accountName,
					createdAt: new Date(0),
					modifiedAt: n.modifiedAt,
					isPasswordProtected: false,
				})),
		readNote: (noteId): AppleNotesContent => {
			readCount += 1;
			const note = notes.find((n) => n.id === noteId);
			if (!note) throw new Error(`note ${noteId} not in fake`);
			return {
				meta: {
					id: note.id,
					title: note.title,
					folderName: note.folderName,
					accountName: note.accountName,
					createdAt: new Date(0),
					modifiedAt: note.modifiedAt,
					isPasswordProtected: false,
				},
				markdown: note.body ?? `# ${note.title}\n\nbody for ${note.id}.`,
			};
		},
		close: () => {},
	};
	return {
		reader,
		readCount: () => readCount,
		resetReadCount: () => {
			readCount = 0;
		},
	};
}

/**
 * macTimeToDate in macos-ts is `new Date((macSeconds + 978307200) * 1000)`,
 * which can produce fractional milliseconds before the Date constructor's
 * floor. Mirror that here so the test exercises the same code path the
 * production reader hits.
 */
function macModifiedAt(macSeconds: number): Date {
	return new Date((macSeconds + 978307200) * 1000);
}

const NOTE1_MTIME = macModifiedAt(700_000_000.5);
const NOTE2_MTIME = macModifiedAt(700_000_001.25);
const NOTE3_MTIME = macModifiedAt(700_000_002.75);

const NOTES: FakeNote[] = [
	{ id: 101, title: "Pasta", folderName: "Recipes", accountName: "iCloud", modifiedAt: NOTE1_MTIME },
	{ id: 102, title: "Risotto", folderName: "Recipes", accountName: "iCloud", modifiedAt: NOTE2_MTIME },
	{ id: 103, title: "Q1 Plan", folderName: "Meetings", accountName: "iCloud", modifiedAt: NOTE3_MTIME },
];

// Mutable handle so each test gets a fresh fake without re-wiring the
// module mock. `openNoteReader` is dereferenced through this closure at
// call time, so reassigning `currentHandle` in beforeEach is enough to
// swap the reader the plugin sees.
let currentHandle: FakeReaderHandle = buildFakeReader(NOTES);

// Replace the sqlite/macos-ts I/O layer (reader.ts) and the darwin-only
// platform check so the test exercises the plugin's enumerate + fetch
// orchestration against an in-memory fake. We're not mocking the subject
// of the test (`apple-notes.ts` / `ingest.ts`) — only the I/O boundary.
mock.module("../../../src/ingest/apple-notes/reader.ts", () => ({
	openNoteReader: () => currentHandle.reader,
}));
mock.module("../../../src/ingest/apple-notes/platform.ts", () => ({
	assertAppleNotesPlatform: () => {},
	mapAppleNotesError: (err: unknown) => (err instanceof Error ? err : new Error(String(err))),
}));

// apple-notes is registered only on darwin (see registry.ts:31), so on
// linux CI the plugin isn't in the registry and `apple-notes:` doesn't
// resolve. Mocking `platform.ts` doesn't help — the gate runs at
// import-time inside registerSource(). Skip the whole suite off-darwin.
describe.if(process.platform === "darwin")("apple-notes probeUnchanged round-trip", () => {
	let tmp: string;
	let ctx: AppContext;

	beforeEach(async () => {
		tmp = realpathSync(mkdtempSync(join(tmpdir(), "membot-apple-notes-")));
		setEmbeddingCacheDir(join(tmp, "models"));
		const config = MembotConfigSchema.parse({ data_dir: tmp });
		const db = await openDb(join(tmp, "index.duckdb"));
		ctx = {
			config,
			dataDir: tmp,
			configPath: join(tmp, "config.json"),
			db,
			logger,
			progress: createProgress(),
		};
		currentHandle = buildFakeReader(NOTES);
	});

	afterEach(async () => {
		await closeContext(ctx);
		rmSync(tmp, { recursive: true, force: true });
	});

	test("first add persists source_mtime_ms equal to entry.mtimeMs", async () => {
		const result = await addOperation.handler({ sources: ["apple-notes:"], follow_symlinks: true, force: false }, ctx);
		expect(result.ok).toBe(NOTES.length);
		expect(result.unchanged).toBe(0);

		const pastaPath = "apple-notes/icloud/recipes/pasta.md";
		const cur = await getCurrent(ctx.db, pastaPath);
		expect(cur).not.toBeNull();
		expect(cur?.source_mtime_ms).toBe(NOTE1_MTIME.getTime());
		expect(typeof cur?.source_mtime_ms).toBe("number");
	}, 180_000);

	test("second add with same mtimes reports every note unchanged and skips readNote", async () => {
		await addOperation.handler({ sources: ["apple-notes:"], follow_symlinks: true, force: false }, ctx);
		currentHandle.resetReadCount();

		const result = await addOperation.handler({ sources: ["apple-notes:"], follow_symlinks: true, force: false }, ctx);
		expect(result.ok).toBe(0);
		expect(result.unchanged).toBe(NOTES.length);
		expect(result.failed).toBe(0);
		// probeUnchanged short-circuits BEFORE fetcher.fetch(), which is what
		// calls readNote() under the hood. If even one readNote happened on
		// the second pass the cheap gate isn't firing.
		expect(currentHandle.readCount()).toBe(0);
	}, 180_000);

	test("editing one note (mtime + body) re-ingests only that note", async () => {
		await addOperation.handler({ sources: ["apple-notes:"], follow_symlinks: true, force: false }, ctx);
		currentHandle.resetReadCount();

		// Simulate a real edit in Apple Notes: both modifiedAt and the body
		// change. Bumping mtime alone would still pass the post-fetch sha
		// gate (bytes identical) and report unchanged, so to exercise the
		// re-persist path the body has to change too.
		const bumped = new Date(NOTE1_MTIME.getTime() + 60_000);
		const target = NOTES.find((n) => n.id === 101);
		if (!target) throw new Error("unreachable");
		const originalMtime = target.modifiedAt;
		const originalBody = target.body;
		target.modifiedAt = bumped;
		target.body = "# Pasta\n\nrevised body for 101.";
		// Rebuild so listFolders/listNotesIn pick up the mutated note.
		currentHandle = buildFakeReader(NOTES);

		try {
			const result = await addOperation.handler(
				{ sources: ["apple-notes:"], follow_symlinks: true, force: false },
				ctx,
			);
			expect(result.ok).toBe(1);
			expect(result.unchanged).toBe(NOTES.length - 1);
			// Only the bumped note was fetched; the cheap mtime gate
			// short-circuited the other two before readNote().
			expect(currentHandle.readCount()).toBe(1);

			const pastaPath = "apple-notes/icloud/recipes/pasta.md";
			const cur = await getCurrent(ctx.db, pastaPath);
			expect(cur?.source_mtime_ms).toBe(bumped.getTime());
		} finally {
			// Restore the shared fixture — the NOTES array is module-scoped,
			// so leaking a mutation breaks the next test.
			target.modifiedAt = originalMtime;
			target.body = originalBody;
		}
	}, 180_000);

	test("row with NULL source_mtime_ms falls back to fetch-then-sha gate", async () => {
		// Seed a row by hand without source_mtime_ms — mimics rows created
		// before the probeUnchanged feature shipped or after a manual edit.
		const pastaPath = "apple-notes/icloud/recipes/pasta.md";
		const markdown = "# Pasta\n\nbody for 101.";
		const sha = await import("node:crypto").then((c) =>
			c.createHash("sha256").update(new TextEncoder().encode(markdown)).digest("hex"),
		);
		await insertVersion(ctx.db, {
			logical_path: pastaPath,
			source_type: "remote",
			source_path: "apple-notes://note/101",
			source_mtime_ms: null,
			source_sha256: sha,
			content: markdown,
			mime_type: "text/markdown",
			size_bytes: new TextEncoder().encode(markdown).byteLength,
			fetcher: "downloader",
			downloader: "apple-notes",
			downloader_args: { noteId: 101, accountName: "iCloud", folderName: "Recipes", title: "Pasta" },
		});

		// Add just this one note's folder so the test stays scoped to the
		// row we seeded. The cheap gate sees source_mtime_ms=NULL and
		// falls through; the post-fetch sha gate at ingest.ts:340-348
		// should still mark it unchanged because the markdown is byte-stable.
		const result = await addOperation.handler(
			{ sources: ["apple-notes:iCloud/Recipes"], follow_symlinks: true, force: false },
			ctx,
		);
		const entry = result.ingested.find((e) => e.logical_path === pastaPath);
		expect(entry?.status).toBe("unchanged");
	}, 180_000);
});
