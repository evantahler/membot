/**
 * Side-effect imports: each plugin file calls `registerSource(...)` at
 * module-load time. Order matters — `findSourceForInput` walks the
 * registry in insertion order and returns the first match.
 *
 * Adding a new source is one file + one line here. Auto-disabled on
 * platforms the plugin's `platform` field excludes (apple-notes on
 * non-darwin), so this list is safe to keep flat.
 */
import "./google-docs.ts";
import "./google-sheets.ts";
import "./google-slides.ts";
import "./github.ts";
import "./linear.ts";
import "./apple-notes.ts";

export * from "./registry.ts";
export * from "./types.ts";
