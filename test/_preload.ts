// Bun test preload. The transformers WASM patch must be applied on disk
// before tests can import the embedder; we run the prebuild script here
// idempotently (it's a no-op when every marker file exists) so tests don't
// fail silently when devs forget to run `bun run prebuild`.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const markers = [
	"node_modules/@huggingface/transformers/.membot-transformers-patch-applied",
	"node_modules/@evantahler/mcpx/.membot-mcpx-patch-applied",
];

if (markers.some((m) => !existsSync(m))) {
	spawnSync("bash", ["scripts/apply-patches.sh"], { stdio: "inherit" });
}

process.env.NO_COLOR ??= "1";
// Force non-interactive default in tests.
delete process.env.FORCE_COLOR;
