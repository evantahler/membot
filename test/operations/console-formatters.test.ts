import { afterEach, describe, expect, test } from "bun:test";
import ansis from "ansis";
import { addOperation } from "../../src/operations/add.ts";
import { diffOperation } from "../../src/operations/diff.ts";
import { infoOperation } from "../../src/operations/info.ts";
import { listOperation } from "../../src/operations/list.ts";
import { moveOperation } from "../../src/operations/move.ts";
import { pruneOperation } from "../../src/operations/prune.ts";
import { readOperation } from "../../src/operations/read.ts";
import { refreshOperation } from "../../src/operations/refresh.ts";
import { removeOperation } from "../../src/operations/remove.ts";
import { searchOperation } from "../../src/operations/search.ts";
import { treeOperation } from "../../src/operations/tree.ts";
import { versionsOperation } from "../../src/operations/versions.ts";
import { writeOperation } from "../../src/operations/write.ts";
import { detectMode, setMode } from "../../src/output/tty.ts";

const STRIP = (s: string) => ansis.strip(s);

afterEach(() => {
	setMode(detectMode({}));
});

describe("list.console_formatter", () => {
	test("includes path, formatted size, status, and footer count", () => {
		const out =
			listOperation.console_formatter?.({
				entries: [
					{
						logical_path: "docs/a.md",
						version_id: "v1",
						size_bytes: 12,
						mime_type: "text/markdown",
						refresh_frequency_sec: null,
						last_refresh_status: "ok",
						refreshed_at: null,
						description: null,
					},
				],
				count: 1,
			}) ?? "";
		expect(STRIP(out)).toContain("docs/a.md");
		expect(STRIP(out)).toContain("12B");
		expect(STRIP(out)).toContain("text/markdown");
		expect(STRIP(out)).toContain("ok");
		expect(STRIP(out)).toContain("1 entry");
	});

	test("empty result is '(no entries)'", () => {
		const out = listOperation.console_formatter?.({ entries: [], count: 0 }) ?? "";
		expect(STRIP(out)).toBe("(no entries)");
	});

	test("under NO_COLOR, no escape bytes anywhere", () => {
		setMode(detectMode({ noColor: true }));
		const out =
			listOperation.console_formatter?.({
				entries: [
					{
						logical_path: "x",
						version_id: "v",
						size_bytes: 1,
						mime_type: null,
						refresh_frequency_sec: null,
						last_refresh_status: "ok",
						refreshed_at: null,
						description: null,
					},
				],
				count: 1,
			}) ?? "";
		expect(out).not.toContain("\x1b[");
	});
});

describe("tree.console_formatter", () => {
	test("renders root and nested nodes", () => {
		const out =
			treeOperation.console_formatter?.({
				root: "/",
				tree: [
					{
						name: "docs",
						full_path: "docs",
						is_file: false,
						children: [{ name: "a.md", full_path: "docs/a.md", is_file: true }],
					},
				],
			}) ?? "";
		const visible = STRIP(out);
		expect(visible).toContain("/");
		expect(visible).toContain("docs");
		expect(visible).toContain("a.md");
		expect(visible).toMatch(/├── |└── /);
	});

	test("empty tree shows '(empty)'", () => {
		const out = treeOperation.console_formatter?.({ root: "/", tree: [] }) ?? "";
		expect(STRIP(out)).toContain("(empty)");
	});
});

describe("search.console_formatter", () => {
	test("renders one block per hit with path, version, score, snippet, and footer", () => {
		const out =
			searchOperation.console_formatter?.({
				hits: [
					{
						logical_path: "docs/a.md",
						version_id: "v1",
						chunk_index: 0,
						snippet: "matched line",
						score: 0.875,
						semantic_score: 0.9,
						keyword_score: 0.5,
					},
				],
				mode: "hybrid",
			}) ?? "";
		const visible = STRIP(out);
		expect(visible).toContain("docs/a.md");
		expect(visible).toContain("v=v1");
		expect(visible).toContain("score=0.875");
		expect(visible).toContain("matched line");
		expect(visible).toContain("1 hit in hybrid mode");
	});

	test("empty result reports '(no hits)' for the requested mode", () => {
		const out = searchOperation.console_formatter?.({ hits: [], mode: "keyword" }) ?? "";
		expect(STRIP(out)).toContain("(no hits in keyword mode)");
	});
});

describe("info.console_formatter", () => {
	test("renders header + key/value pairs for an existing version", () => {
		const out =
			infoOperation.console_formatter?.({
				logical_path: "docs/a.md",
				version_id: "v1",
				version_is_current: true,
				source_type: "local",
				source_path: "/tmp/a.md",
				source_sha256: "deadbeef",
				blob_sha256: "deadbeef",
				content_sha256: "deadbeef",
				mime_type: "text/markdown",
				size_bytes: 100,
				description: "x",
				fetcher: "local",
				fetcher_server: null,
				fetcher_tool: null,
				fetcher_args: null,
				refresh_frequency_sec: null,
				refreshed_at: null,
				last_refresh_status: "ok",
				change_note: null,
				created_at: "2025-01-01",
				tombstone: false,
			}) ?? "";
		const visible = STRIP(out);
		expect(visible).toContain("docs/a.md");
		expect(visible).toContain("@ v1");
		expect(visible).toContain("current");
		expect(visible).toContain("yes");
		expect(visible).toContain("deadbeef");
		expect(visible).toContain("text/markdown");
	});

	test("tombstoned versions show [tombstoned] tag", () => {
		const out =
			infoOperation.console_formatter?.({
				logical_path: "x",
				version_id: "v",
				version_is_current: false,
				source_type: "local",
				source_path: null,
				source_sha256: null,
				blob_sha256: null,
				content_sha256: null,
				mime_type: null,
				size_bytes: null,
				description: null,
				fetcher: null,
				fetcher_server: null,
				fetcher_tool: null,
				fetcher_args: null,
				refresh_frequency_sec: null,
				refreshed_at: null,
				last_refresh_status: null,
				change_note: null,
				created_at: "2025-01-01",
				tombstone: true,
			}) ?? "";
		expect(STRIP(out)).toContain("[tombstoned]");
	});
});

describe("versions.console_formatter", () => {
	test("marks current version with arrow and tombstones with status", () => {
		const out =
			versionsOperation.console_formatter?.({
				logical_path: "docs/a.md",
				versions: [
					{
						version_id: "v2",
						content_sha256: "abc123",
						source_sha256: "abc123",
						size_bytes: 50,
						change_note: null,
						last_refresh_status: "ok",
						tombstone: false,
						created_at: "2025-01-02",
					},
					{
						version_id: "v1",
						content_sha256: "abc000",
						source_sha256: "abc000",
						size_bytes: 40,
						change_note: "first",
						last_refresh_status: "ok",
						tombstone: true,
						created_at: "2025-01-01",
					},
				],
			}) ?? "";
		const visible = STRIP(out);
		expect(visible).toContain("docs/a.md");
		expect(visible).toContain("v2");
		expect(visible).toContain("v1");
		expect(visible).toContain("→");
		expect(visible).toContain("tombstone");
	});

	test("empty versions reports '(no versions)'", () => {
		const out = versionsOperation.console_formatter?.({ logical_path: "x", versions: [] }) ?? "";
		expect(STRIP(out)).toContain("(no versions)");
	});
});

describe("diff.console_formatter", () => {
	test("includes header and the diff body", () => {
		const out =
			diffOperation.console_formatter?.({
				logical_path: "docs/a.md",
				a: "v1",
				b: "v2",
				diff: "--- v1\n+++ v2\n+added\n-removed\n unchanged",
			}) ?? "";
		const visible = STRIP(out);
		expect(visible).toContain("docs/a.md");
		expect(visible).toContain("v1 → v2");
		expect(visible).toContain("+added");
		expect(visible).toContain("-removed");
		expect(visible).toContain(" unchanged");
	});

	test("empty diff reports '(no changes)'", () => {
		const out = diffOperation.console_formatter?.({ logical_path: "x", a: "1", b: "2", diff: "" }) ?? "";
		expect(STRIP(out)).toContain("(no changes)");
	});
});

describe("read.console_formatter", () => {
	test("renders metadata header + body for current version", () => {
		const out =
			readOperation.console_formatter?.({
				logical_path: "docs/a.md",
				version_id: "v1",
				mime_type: "text/markdown",
				size_bytes: 5,
				version_is_current: true,
				content: "hello",
				description: null,
				blob_available: false,
			}) ?? "";
		const visible = STRIP(out);
		expect(visible).toContain("docs/a.md");
		expect(visible).toContain("@ v1");
		expect(visible).toContain("[current]");
		expect(visible).toContain("mime=text/markdown");
		expect(visible).toContain("hello");
	});

	test("bytes mode shows base64 length, not the payload", () => {
		const out =
			readOperation.console_formatter?.({
				logical_path: "x",
				version_id: "v1",
				mime_type: "image/png",
				size_bytes: 100,
				version_is_current: false,
				bytes_base64: "AAAA",
				blob_available: true,
			}) ?? "";
		expect(STRIP(out)).toContain("[historical]");
		expect(STRIP(out)).toContain("4 base64 chars");
		expect(STRIP(out)).not.toContain("AAAA"); // payload itself not surfaced in human view
	});
});

describe("add.console_formatter", () => {
	test("renders ✓ per success, ✗ per failure, with summary footer", () => {
		const out =
			addOperation.console_formatter?.({
				ingested: [
					{
						source_path: "/tmp/a.md",
						logical_path: "a.md",
						version_id: "v1",
						status: "ok",
						mime_type: "text/markdown",
						size_bytes: 10,
						fetcher: "local",
						source_sha256: "abc",
					},
					{
						source_path: "/tmp/bad",
						logical_path: "bad",
						version_id: null,
						status: "failed",
						error: "permission denied",
						mime_type: null,
						size_bytes: 0,
						fetcher: "local",
						source_sha256: "",
					},
				],
				total: 2,
				ok: 1,
				unchanged: 0,
				failed: 1,
			}) ?? "";
		const visible = STRIP(out);
		expect(visible).toContain("✓ a.md");
		expect(visible).toContain("✗ /tmp/bad");
		expect(visible).toContain("permission denied");
		expect(visible).toContain("added 1");
		expect(visible).toContain("failed 1");
	});

	test("all-success result omits 'failed' from the footer", () => {
		const out =
			addOperation.console_formatter?.({
				ingested: [
					{
						source_path: "/tmp/a.md",
						logical_path: "a.md",
						version_id: "v1",
						status: "ok",
						mime_type: null,
						size_bytes: 1,
						fetcher: "local",
						source_sha256: "x",
					},
				],
				total: 1,
				ok: 1,
				unchanged: 0,
				failed: 0,
			}) ?? "";
		const visible = STRIP(out);
		expect(visible).toContain("added 1");
		expect(visible).not.toContain("failed");
	});

	test("renders ≡ per unchanged entry and surfaces unchanged count", () => {
		const out =
			addOperation.console_formatter?.({
				ingested: [
					{
						source_path: "/tmp/a.md",
						logical_path: "a.md",
						version_id: "v1",
						status: "unchanged",
						mime_type: "text/markdown",
						size_bytes: 10,
						fetcher: "local",
						source_sha256: "abc",
					},
				],
				total: 1,
				ok: 0,
				unchanged: 1,
				failed: 0,
			}) ?? "";
		const visible = STRIP(out);
		expect(visible).toContain("≡ a.md");
		expect(visible).toContain("unchanged 1");
	});
});

describe("refresh.console_formatter", () => {
	test("differentiates updated/unchanged/failed and reports counts", () => {
		const out =
			refreshOperation.console_formatter?.({
				processed: [
					{ logical_path: "a", status: "ok", new_version_id: "v2" },
					{ logical_path: "b", status: "unchanged" },
					{ logical_path: "c", status: "failed", error: "404" },
				],
				count: 3,
			}) ?? "";
		const visible = STRIP(out);
		expect(visible).toContain("✓ a");
		expect(visible).toContain("· b");
		expect(visible).toContain("✗ c");
		expect(visible).toContain("updated 1");
		expect(visible).toContain("unchanged 1");
		expect(visible).toContain("failed 1");
	});

	test("empty queue reports '(nothing due to refresh)'", () => {
		const out = refreshOperation.console_formatter?.({ processed: [], count: 0 }) ?? "";
		expect(STRIP(out)).toContain("(nothing due to refresh)");
	});
});

describe("prune.console_formatter", () => {
	test("dry-run shows [dry-run] tag and removed-version count", () => {
		const out =
			pruneOperation.console_formatter?.({
				cutoff: "2025-01-01T00:00:00Z",
				removed_versions: 5,
				removed_orphan_blobs: 0,
				dry_run: true,
			}) ?? "";
		const visible = STRIP(out);
		expect(visible).toContain("[dry-run]");
		expect(visible).toContain("5 versions");
	});

	test("applied result reports both versions and reclaimed blobs", () => {
		const out =
			pruneOperation.console_formatter?.({
				cutoff: "2025-01-01T00:00:00Z",
				removed_versions: 1,
				removed_orphan_blobs: 2,
				dry_run: false,
			}) ?? "";
		const visible = STRIP(out);
		expect(visible).toContain("[applied]");
		expect(visible).toContain("1 version");
		expect(visible).toContain("2 orphan blobs");
	});
});

describe("write/move/remove .console_formatter", () => {
	test("write emits single confirmation line", () => {
		const out = writeOperation.console_formatter?.({ logical_path: "a", version_id: "v1", size_bytes: 12 }) ?? "";
		const visible = STRIP(out);
		expect(visible).toContain("✓ a");
		expect(visible).toContain("@ v1");
		expect(visible).toContain("12B");
	});

	test("move shows 'from → to' with the new version id", () => {
		const out =
			moveOperation.console_formatter?.({
				from_logical_path: "old.md",
				to_logical_path: "new.md",
				new_version_id: "v3",
			}) ?? "";
		const visible = STRIP(out);
		expect(visible).toContain("old.md");
		expect(visible).toContain("new.md");
		expect(visible).toContain("→");
		expect(visible).toContain("@ v3");
	});

	test("remove confirms tombstone with version id", () => {
		const out = removeOperation.console_formatter?.({ logical_path: "a", tombstone_version_id: "v9" }) ?? "";
		const visible = STRIP(out);
		expect(visible).toContain("tombstoned a");
		expect(visible).toContain("@ v9");
	});

	test("all three are clean text under NO_COLOR", () => {
		setMode(detectMode({ noColor: true }));
		const w = writeOperation.console_formatter?.({ logical_path: "a", version_id: "v1", size_bytes: 1 }) ?? "";
		const m =
			moveOperation.console_formatter?.({
				from_logical_path: "a",
				to_logical_path: "b",
				new_version_id: "v",
			}) ?? "";
		const r = removeOperation.console_formatter?.({ logical_path: "a", tombstone_version_id: "v" }) ?? "";
		for (const out of [w, m, r]) expect(out).not.toContain("\x1b[");
	});
});
