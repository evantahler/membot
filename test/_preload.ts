// Bun test preload. The transformers WASM patch must be applied on disk
// before tests can import the embedder; we run the prebuild script here
// idempotently (it's a no-op when every marker file exists) so tests don't
// fail silently when devs forget to run `bun run prebuild`.
import { existsSync } from "node:fs";
import { $ } from "bun";

const markers = ["node_modules/@huggingface/transformers/.membot-transformers-patch-applied"];

if (markers.some((m) => !existsSync(m))) {
	await $`bash scripts/apply-patches.sh`;
}

process.env.NO_COLOR ??= "1";
// Force non-interactive default in tests.
delete process.env.FORCE_COLOR;
