/**
 * Server-level instructions sent to the LLM when it connects to membot's
 * MCP server. Frames how the tool surface should be used: discovery →
 * ingest → consume → write, with explicit notes on versioning and refresh.
 */
export const SERVER_INSTRUCTIONS = `You have a persistent context store. Files live as versioned markdown rows
addressed by logical path (e.g. "research/threat-models/llm.md"). The store
is a hybrid search index: every file is chunked, embedded locally, and
indexed with BM25 — so prefer membot_search to membot_read+grep for discovery.
Call membot_sources before membot_add when unsure what input shapes are
supported; membot_stats to confirm the index has content.

Workflow:
  1. membot_tree or membot_search to find what already exists before adding new content.
  2. membot_add to ingest a local file, directory, glob, URL, or "inline:<text>".
     Remote URLs go to per-service downloaders — GitHub (issues/PRs/repos) and
     Linear (issues/projects/teams) over their HTTP APIs, plus Apple Notes
     locally on macOS. Token services read an API key from config (set via
     \`membot config set downloaders.<svc>.api_key\`); \`membot login\` only PRINTS
     those setup commands — it never opens a browser or stores cookies. Call
     membot_sources to see exactly which URL/scheme shapes are ingestable.
     Arbitrary URLs — including Google Docs/Sheets/Slides — are NOT fetched;
     export the file locally as .docx/.pdf and membot_add the path instead.
     Each row records which downloader ran so refresh replays it deterministically.
  3. membot_read or membot_search hits to consume content.
  4. membot_write to record agent-authored notes (source_type='inline').

Other tools: membot_sources (what's ingestable), membot_stats / membot_info
(inspect the index or a single row), membot_versions / membot_diff (history),
membot_move / membot_remove (rename / tombstone), membot_prune (drop history).

Versioning:
  - Every ingest, refresh, or write that changes content creates a NEW
    version_id (a timestamp). Older versions stay queryable via the
    \`version\` parameter on membot_read / membot_info / membot_versions / membot_diff.
  - All other tools default to the current (latest, non-tombstoned) version.
  - membot_remove is a tombstone — history is preserved unless membot_prune runs.

Refresh:
  - Each row has source metadata. membot_refresh re-reads the source, hashes
    it, and only re-embeds when bytes changed. Safe to call often.
  - If a file has refresh_frequency_sec set, the daemon refreshes it
    automatically — you do not need to schedule it yourself.

When in doubt: search before you read, read before you write, and prefer
adding the source URL once (with a refresh interval) over copy-pasting
content that will go stale.`;
