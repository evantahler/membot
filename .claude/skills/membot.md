---
name: membot
description: Persistent, versioned context store for AI agents — ingest, search, read, and write knowledge via the membot CLI or MCP server
trigger: when the user wants to remember, recall, or search project knowledge, ingest documents into a long-lived store, or surface relevant context for a task
---

# membot — Persistent Context for Agents

You have access to a long-lived context store via `membot`. Files (markdown, PDFs, DOCX, HTML, URLs, agent notes) are ingested, converted to markdown, chunked, embedded locally, and indexed in DuckDB with hybrid search (semantic + BM25). Every artifact is addressed by a virtual `logical_path`. Every change creates a new immutable version — nothing is overwritten in place.

Use this workflow:

## 1. Discover what's already there

Before ingesting, check whether the knowledge already exists.

```bash
membot tree                         # synthesised directory tree of logical_paths
membot ls                           # one row per current file (size, mime, refresh status)
membot ls docs/                     # filter by prefix
membot search "<question>"          # hybrid search (semantic + keyword)
```

`search` is the primary discovery tool — prefer it over scanning files.

## 2. Ingest

```bash
membot add ./README.md                                            # single file
membot add ./docs                                                 # recursive directory walk
membot add "docs/**/*.md"                                         # glob
membot add a.md b.md "docs/**/*.md"                               # any number of args; each resolved independently
membot add ./drive-export.docx                                    # Google Docs/Sheets/Slides: export from Drive and add the file
membot add https://github.com/<owner>/<repo>/issues/<n>           # GitHub issues + PRs (with comments)
membot add https://linear.app/<workspace>/issue/<KEY>             # Linear issues + projects
membot add ./local-copy.pdf                                       # for arbitrary content: download locally and add the file
membot add "apple-notes:"                                         # all Apple Notes (macOS-only)
membot add "apple-notes:Personal/Recipes"                         # one folder
membot add "apple-notes:Personal/Recipes/**" --sync               # one folder + nested; tombstone deleted notes
membot add "inline:Decision: use X because Y"                     # literal text
membot add ./docs --refresh-frequency 24h                         # auto-refresh every day
```

Remote URLs go through a source-plugin registry. Each plugin owns its
URL match, auth strategy, and rendering. The set below is auto-generated
from the live registry — call `membot sources` (or the `membot_sources`
MCP tool) to inspect it at runtime.

<!-- AUTO-GENERATED:sources -->

| Plugin | Auth | Examples | Notes |
| --- | --- | --- | --- |
| **github**<br>GitHub issues & PRs — uses the GitHub REST API (with optional token for private repos). | `api_key` — `membot config set downloaders.github.api_key <PAT>` | `https://github.com/<owner>/<repo>/issues/<n>`<br>`https://github.com/<owner>/<repo>/pull/<n>` | Public repos work unauthenticated at 60 req/hr. For private repos or higher limits, configure a token: `membot config set downloaders.github.api_key <PAT>` or export `GITHUB_TOKEN`. |
| **github-repo**<br>GitHub repository bulk import — open issues and PRs (selectable, optionally including closed) via the GitHub REST API. | `api_key` — `membot config set downloaders.github.api_key <PAT>` | `github-repo:facebook/react`<br>`github-repo:owner/repo:issues`<br>`github-repo:owner/repo:prs:all`<br>`github-repo:owner/repo:all` | Default selector pulls open issues + open PRs. Override with `:issues`, `:prs`, `:issues:all`, `:prs:all`, `:all`. Uses the same API key as the per-URL github plugin (`membot config set downloaders.github.api_key <PAT>` or `GITHUB_TOKEN`). Pass --sync to tombstone items no longer returned by the enumerate; with an open-only selector, closing an item will tombstone it — use `:all` selectors to keep closed items. |
| **linear**<br>Linear issues & projects — uses the Linear GraphQL API with a personal access key. | `api_key` — `membot config set downloaders.linear.api_key <KEY>` | `https://linear.app/<workspace>/issue/<KEY>`<br>`https://linear.app/<workspace>/project/<slug>` | Requires a personal API key from https://linear.app/settings/api. Set it via `membot config set downloaders.linear.api_key <KEY>`. |
| **linear-team**<br>Linear team bulk import — every project under a team plus every issue in those projects, via the Linear GraphQL API. | `api_key` — `membot config set downloaders.linear.api_key <KEY>` | `linear-team:ENG`<br>`linear-team:DESIGN` | Same API key as the per-URL linear plugin (`membot config set downloaders.linear.api_key <KEY>`). Team key is the uppercase prefix of issue IDs (e.g. ENG from ENG-42). Pass --sync to tombstone projects/issues that have been deleted from Linear. |
| **apple-notes** _(darwin only)_<br>Apple Notes (macOS) — scope-driven import via NoteStore.sqlite. Markdown comes straight from the protobuf body. | none | `apple-notes:`<br>`apple-notes:Personal/Recipes`<br>`apple-notes:*/Archive`<br>`apple-notes:Personal/Recipes/**` | Requires Full Disk Access for your terminal in System Settings → Privacy & Security. Password-protected notes and Recently Deleted are skipped. Pass `--sync` to tombstone rows whose notes have been deleted. |

<!-- /AUTO-GENERATED:sources -->

API-key plugins (GitHub, Linear) need a credential set via `membot
config set downloaders.<svc>.api_key` — run `membot login` to see the
exact commands. If a fetch fails with an auth error, the
`HelpfulError` will tell you exactly which command to run. Fetches
are non-interactive — they never prompt or open a browser.

**Google Docs / Sheets / Slides have no built-in plugin.** Two options:

1. **One-off**: in Google Drive, `File → Download → Microsoft Word (.docx)` (or `.xlsx` / `.pdf`) and `membot add ./that-file.docx`.
2. **Repeated use**: register a **custom router** that delegates the fetch to whatever already has Google auth on the user's machine. If `mcpx` is set up:

   ```bash
   membot router add \
     --name google-docs \
     --url-pattern '^https://docs\.google\.com/document/d/(?<doc_id>[a-zA-Z0-9_-]+)' \
     --command mcpx \
     --args 'exec,GoogleDocs_GetDocumentAsDocmd,--doc-id,{doc_id}' \
     --mime-type text/markdown \
     --post-process docmd
   ```

   After that, `membot add https://docs.google.com/document/d/<id>/edit` works as normal, and `membot refresh` re-runs the same command. See [Custom URL routers](#custom-url-routers) below for the full mechanism.

**Apple Notes** (`apple-notes:` scheme, macOS-only) reads `NoteStore.sqlite` directly via `macos-ts` — no AppleScript, no browser, just a fast local SQLite read. The scope syntax is `apple-notes:[<account-glob>[/<folder-glob>]]` and supports the same `*`/`**`/`?` wildcards as filesystem globs:

| Source                                       | Matches                                              |
| -------------------------------------------- | ---------------------------------------------------- |
| `apple-notes:`                               | all notes, all accounts, all folders                 |
| `apple-notes:Personal`                       | all notes in the `Personal` account                  |
| `apple-notes:Personal/Recipes`               | exactly the `Recipes` folder                         |
| `apple-notes:Personal/Recipes/**`            | `Recipes` and any nested subfolders                  |
| `apple-notes:*/Inbox`                        | a folder named `Inbox` in any account                |
| `apple-notes:**/Archive/**`                  | anything under any folder named `Archive`            |

Each note's body is rendered to markdown by `macos-ts` (no LLM round-trip). Notes land at `apple-notes/<account>/<folder>/<title>.md` (slug-cased; collisions get a deterministic `-<noteId>` suffix). Password-protected notes are skipped with a per-entry warning. **`Recently Deleted` is excluded from wildcard scopes** — name it explicitly (e.g. `apple-notes:iCloud/Recently Deleted`) to include the trash. Attachments and shared-note participants are out of scope for v1.

Requires **Full Disk Access** for your terminal/editor in System Settings → Privacy & Security → Full Disk Access. The error message names the exact pane to open.

Pass `--sync` to reconcile deletions: after ingest, any current row inside the scope whose underlying note no longer exists in Notes.app is tombstoned. Without `--sync`, deletes are not detected.

### Custom URL routers

For URLs no built-in plugin claims, the user can register a **custom router** that dispatches the fetch to an external shell command. This is the supported way to ingest Google Docs / Sheets / Slides (and anything else whose auth lives outside membot — `mcpx`, `gws`, `gcloud`, `gh`, a private script, …). One-time setup, then `membot add <url>` works as normal; refresh replays the same command deterministically.

```bash
# Google Docs via mcpx (assuming the user has mcpx configured with a Google MCP server)
membot router add \
  --name google-docs \
  --url-pattern '^https://docs\.google\.com/document/d/(?<doc_id>[a-zA-Z0-9_-]+)' \
  --command mcpx \
  --args 'exec,GoogleDocs_GetDocumentAsDocmd,--doc-id,{doc_id}' \
  --mime-type text/markdown \
  --post-process docmd

membot router list                                # show configured routers
membot router test <url>                          # show which router matches + extracted vars (no spawn)
membot router test <url> --exec                   # also run the command + post-process and print stdout
membot router remove <name>                       # delete a router
```

Rules of thumb:
- `--url-pattern` is a JS regex. Named groups `(?<name>...)` become `{name}` substitution variables; `{url}` substitutes the full URL.
- `--command` + `--args` form an argv array (no shell, no interpolation). The user-supplied id can't escape its argv slot.
- `--mime-type` declares what the command's stdout is; it flows through the normal converter pipeline.
- `--post-process` is one of `passthrough` (default), `docmd` (for Google's docmd format — light cleanup), `html-to-markdown` (Turndown). For anything else, pass `--post-process-command <cmd>` + `--post-process-args <csv>` to pipe the bytes through any external script (`pandoc`, `jq`, …).
- Built-in plugins always win on overlapping patterns. Custom routers only fire when no built-in claims the URL.
- Suggest these to the user; don't unilaterally run `membot router add` for them — it changes future ingest behaviour.

Each entry becomes a new version under its own `logical_path`. PDFs/DOCX/HTML are converted to markdown; images get vision captions; original bytes are kept and reachable via `membot read --bytes` — except for sources that exceed `blobs.max_size_bytes` (default 25 MB) or whose mime matches `blobs.skip_mime_types` (default `video/*`, `audio/*`). The metadata row is still inserted (so refresh and dedupe still work) but `read --bytes` will fail with a hint pointing at the config knob; raise the limit and re-ingest to capture the bytes.

The default `logical_path` mirrors the source path so files with the same basename in different projects don't collide:

- Local file → absolute path with leading `/` stripped (e.g. `/Users/me/projA/README.md` → `Users/me/projA/README.md`).
- Local directory or glob → each entry's absolute path under the same shape.
- URL → `remotes/{host}/{path}` with `/`'s preserved (e.g. `https://github.com/userA/projA/blob/main/README.md` → `remotes/github.com/userA/projA/blob/main/README.md`). Query strings and fragments are dropped from the logical_path (the full URL is still stored for refresh).
- `inline:<text>` → `inline/{timestamp}.md`.

Pass `-p <path>` (or `--logical-path`) to override. On a directory walk it's treated as a *prefix* — entries land at `{prefix}/{path-relative-to-walk-base}`. Re-running `membot add` on the same source reuses the same logical_path and creates a new version (correct refresh behavior).

## 3. Read

```bash
membot read <logical_path>                       # current markdown surrogate (ANSI-rendered on a TTY)
membot read <logical_path> --raw                 # unrendered markdown — skip the TTY ANSI styling
membot read <logical_path> --bytes               # original bytes (base64) — PDF/DOCX/image as ingested
membot read <logical_path> --version <ts>        # historical snapshot
membot info <logical_path>                       # metadata only (no content)
membot stats [prefix]                            # whole-index summary; optional prefix scopes the aggregates
membot versions <logical_path>                   # every version, newest first
membot diff <logical_path> --a <ts> [--b <ts>]   # unified diff between versions
```

Defaults to the current (non-tombstoned) version. Pass `--version` only when you need history.

## 4. Write your own notes

Persist agent-authored summaries, decisions, or synthesised context so they survive across conversations:

```bash
membot write notes/decision-2026-05.md --content "Decided to ..."
```

Inline writes create a new `(logical_path, version_id)` row just like file ingests — `membot versions` lists them, `membot diff` compares them. To mirror an external doc that should re-fetch over time, use `membot add <url> --refresh-frequency` instead.

## 5. Refresh, rename, delete, prune

```bash
membot refresh <logical_path>          # re-read source; new version only if bytes changed
membot refresh                         # refresh all rows whose schedule has elapsed
membot mv old/path new/path            # rename (history preserved under both)
membot rm <paths...>                   # tombstone one or more paths/globs (history still queryable)
membot rm "docs/**/*.md" notes/old.md  # globs match logical_paths in the DB; literals + globs can mix
membot rm -r remotes/docs.google.com   # --recursive removes every path under a directory prefix
membot prune --before <iso-ts>         # drop non-current versions older than cutoff (irreversible)
```

Tombstones hide a path from `ls` / `tree` / `search` but `versions` and `read --version <ts>` still work. Pruning is the only way to actually remove data.

## Versioning rules

- Defaults always operate on the current, non-tombstoned version.
- Pass an explicit `--version <timestamp>` (from `membot versions`) to read or diff history.
- `membot_add` (when source bytes have changed), refresh-with-changes, `write`, and `mv` each create a new version. The previous version is preserved. Re-running `membot_add` against an unchanged source is a no-op (status `unchanged`, same `version_id`); pass `force=true` to force a new version.
- Mutating an existing version is not possible — corrections are new versions.

## When to use this skill

- The user asks to remember, recall, save, or look up something across conversations.
- You need project-specific context (specs, decisions, transcripts, rendered docs) that's larger than fits in the prompt.
- You need to ingest a document (PDF, DOCX, HTML, URL) and reason over it.
- You're producing a summary or decision that should survive past this conversation.

## When NOT to use this skill

- Reading a file the user just pointed at — use the regular file-read tool unless they want it persisted.
- Storing secrets, credentials, or anything that shouldn't sit in `~/.membot/index.duckdb`.
- Quick scratch state for the current turn — keep that in the conversation.

## MCP server

`membot serve` exposes the same operations as MCP tools (`membot_add`, `membot_search`, etc.) over stdio (default) or HTTP (`--http <port>`). When connected, prefer the MCP tools over shelling out — they return structured `outputSchema` data with `version_id` echoed on every read.

Every MCP call (and every refresh-daemon tick) is appended to `~/.membot/logs/serve.log` as a structured JSON record. The log captures tool name, argument keys, duration, result size, and any error kind + hint — never the argument values or result body. Tail it with `membot logs --follow` (or `membot logs --raw | jq` for programmatic use).

## Available commands

| Command                               | Purpose                                                                        |
| ------------------------------------- | ------------------------------------------------------------------------------ |
| `membot add <sources...>`             | Ingest one or more files, directories, globs, URLs, `apple-notes:<scope>`, or `inline:<text>`. Skips unchanged sources; pass `--force` to re-ingest. For `apple-notes:` sources, `--sync` tombstones rows whose underlying note has been deleted in Notes.app |
| `membot ls [prefix]`                  | List current files (size, mime, refresh status)                                |
| `membot tree [prefix]`                | Render the synthesised logical-path tree (`--max-depth`, `--max-items` cap output) |
| `membot read <path>`                  | Read current markdown surrogate (`--bytes` for original; `--raw` skips TTY ANSI rendering) |
| `membot write <path> --content <txt>` | Write inline agent-authored markdown as a new version                          |
| `membot search <query>`               | Hybrid search (semantic + BM25); add `--include-history` to search older versions |
| `membot info <path>`                  | Inspect metadata (source, downloader, refresh schedule, digests) without content |
| `membot stats [prefix]`               | Summarize the index (file/version/chunk/blob counts, on-disk size, refresh health, mime/source/downloader breakdowns); optional prefix scopes |
| `membot versions <path>`              | List every version newest-first with version_id and change notes               |
| `membot diff <path> --a <ts>`         | Unified diff between two versions                                              |
| `membot mv <old> <new>`               | Rename a logical_path (history preserved)                                      |
| `membot rm <paths...>`                | Tombstone one or more logical_paths or globs (e.g. `"docs/**/*.md"`); pass `-r` / `--recursive` to remove a directory prefix; history kept |
| `membot refresh [path]`               | Re-read source; create new version only if bytes changed                       |
| `membot prune --before <ts>`          | Permanently drop non-current versions older than cutoff (irreversible). Add `--strip-blob-bytes` to retroactively NULL out bytes for blobs that exceed current `blobs.max_size_bytes` / `blobs.skip_mime_types`. |
| `membot serve`                        | Start MCP server (stdio default, `--http <port>` for HTTP)                     |
| `membot logs`                         | Print or tail the serve-mode audit log (`~/.membot/logs/serve.log`); `--follow`, `--lines <N>`, `--raw` for JSON |
| `membot reindex`                      | Rebuild the FTS keyword index over current chunks                              |
| `membot config <subcommand>`          | Host-side config management (`get` / `set` / `unset` / `list` / `path`). **Don't run** — this is for the human operator, not for agents |
| `membot router <subcommand>`          | Manage user-defined URL routers (`add` / `list` / `remove` / `test`). Useful when the user wants `membot add <url>` to delegate to an external CLI for fetch (e.g. mcpx for Google Docs). **Suggest, don't run unilaterally** — modifying routers changes future ingest behaviour |
| `membot login`                        | Print `membot config set` instructions for API-key services (GitHub, Linear). **Don't run** — this is for the human operator |

## Output formats

- TTY → spinners, colors, tables. `--no-color` disables ANSI.
- Piped, `--json`, `CI=true`, or `NO_COLOR` → JSON to stdout, structured logs to stderr, no ANSI bytes.
- Use `--json` when parsing output programmatically (it's automatic when piped, but explicit is safer).
- Use `--verbose` if a command fails unexpectedly.

## Troubleshooting

- **"ingest failed: unsupported mime"** → Add a converter or pass `--bytes` to keep the original; LLM-fallback only runs when `ANTHROPIC_API_KEY` is set.
- **Google Docs/Sheets/Slides URL was rejected** → membot has no built-in Google plugin. Either export from Drive as `.docx`/`.xlsx`/`.pdf` and `membot add ./that-file`, or register a custom router that delegates to a tool that already has Google auth (e.g. `mcpx`) — see the "Custom URL routers" section above.
- **"refresh failed: auth"** for a GitHub URL → set the PAT via `membot config set downloaders.github.api_key <PAT>` (or export `GITHUB_TOKEN`).
- **"refresh failed: auth"** for a Linear URL → set the personal API key via `membot config set downloaders.linear.api_key <KEY>` (create one at `linear.app/settings/api`).
- **"Cannot read the Apple Notes database — Full Disk Access required"** → System Settings → Privacy & Security → Full Disk Access → toggle on for your terminal/editor (Terminal, iTerm, Warp, Cursor, VSCode, Conductor). Restart the app and re-run. Open the pane directly: `open 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'`.
- **"Apple Note ... no longer exists"** on refresh → the note was deleted in Notes.app. Reconcile with `membot add apple-notes: --sync` or drop the row with `membot rm <path>`.
- **Search returns nothing** → Confirm the file ingested with `membot info <path>`; if needed, run `membot reindex` to rebuild the FTS keyword index.
- **Stale results after manual DB edits** → `membot reindex`.
- **Two paths point at the same content** → `membot mv` doesn't merge; tombstone one with `membot rm`.

## Configuration

- Data lives in `~/.membot/index.duckdb` (override via `MEMBOT_HOME`).
- Optional `ANTHROPIC_API_KEY` enables LLM fallback for messy/binary input. Without it, conversion degrades to deterministic native output.
- `embedding.workers` (config key) caps the per-command embed-worker subprocess pool spawned at the top of `add` / `refresh` / `write`. Default `null` resolves to `cpus()-1`; set `1` to disable the pool.
- `search.semantic_weight` (config key, default `0.6`, range `[0, 1]`) tilts hybrid-search RRF toward the semantic side. `0.5` = equal, `0.0` = keyword-only behaviour, `1.0` = semantic-only. Search-time queries automatically get the BGE-v1.5 instruction prefix prepended; stored embeddings are unaffected.
- Config file: `~/.membot/config.json` (see `membot --help` for the global flags).
