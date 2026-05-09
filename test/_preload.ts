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
// Disable the embed-worker subprocess pool by default in tests. Many tests
// do tiny writes through writeOperation.handler / addOperation.handler; on
// slow CI runners the cpus()-1 default would spawn 3+ bun subprocesses,
// each loading the full WASM model, blowing the 5s default test timeout
// before the actual assertion runs. Tests that explicitly want the pool
// (test/ingest/embedder-pool.test.ts) construct EmbedderPool directly with
// a worker count, bypassing this default.
process.env.MEMBOT_EMBEDDING_WORKERS ??= "1";
