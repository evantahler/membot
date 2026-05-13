/**
 * Server-level instructions sent to the LLM when it connects to membot's
 * MCP server. Frames how the tool surface should be used: discovery →
 * ingest → consume → write, with explicit notes on versioning and refresh.
 */
export const SERVER_INSTRUCTIONS = `You have a persistent context store. Files live as versioned markdown rows
addressed by logical path (e.g. "research/threat-models/llm.md"). The store
is a hybrid search index: every file is chunked, embedded locally, and
indexed with BM25 — so prefer membot_search to membot_read+grep for discovery.

Workflow:
  1. membot_tree or membot_search to find what already exists before adding new content.
  2. membot_add to ingest a local file, a URL, or a remote document. URLs are
     fetched via per-service downloaders (Google Docs, Sheets, Slides, GitHub,
     Linear, with a generic browser print-to-PDF fallback). Authentication
     comes from the user's logged-in browser cookies (saved via \`membot login\`).
     Each row stores which downloader was used so refresh is deterministic.
  3. membot_read or membot_search hits to consume content.
  4. membot_write to record agent-authored notes (source_type='inline').

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
