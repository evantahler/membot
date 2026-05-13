/**
 * Side-effect imports: each plugin file calls `registerSource(...)` at
 * module-load time. Order matters — `findSourceForInput` walks the
 * registry in insertion order and returns the first match.
 *
 * Adding a new source is one file + one line here. Auto-disabled on
 * platforms the plugin's `platform` field excludes (apple-notes on
 * non-darwin), so this list is safe to keep flat.
 */
import "./github.ts";
import "./github-repo.ts";
import "./linear.ts";
import "./linear-team.ts";
import "./apple-notes.ts";
// Registered LAST so built-in plugins always win on overlapping URL
// patterns. Dynamic-match plugins only run after every static URL
// matcher fails — see `findSourceForInput` in registry.ts.
import "./custom-command.ts";

export * from "./registry.ts";
export * from "./types.ts";
