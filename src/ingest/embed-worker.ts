/**
 * Bun Worker entry: hosts a single transformers feature-extraction pipeline
 * (lazily loaded on the first embed job) and answers embed jobs from the
 * main thread. Each worker in the EmbedPool runs in its own OS thread, so
 * concurrent embed() calls truly parallelize on multi-core CPUs instead of
 * serializing on the main JS event loop.
 *
 * Wire protocol (all messages tagged with `id` and `type`):
 *   in  → { type: "init",  cacheDir?: string }              | one-time setup
 *   out ← { type: "init-ok" }
 *   in  → { type: "embed", id, texts, model }               | per-job
 *   out ← { type: "progress", id, done, total } (repeat)
 *   out ← { type: "result",   id, embeddings }
 *   out ← { type: "error",    id, message }
 */

import { embed, setEmbeddingCacheDir } from "./embedder.ts";

// Local type for the Worker scope's `self`. Bun's typings don't expose a
// dedicated worker-global type, so we just describe the bits we use here.
declare const self: {
	onmessage: (ev: MessageEvent) => void;
	postMessage(message: unknown): void;
};

interface InitMsg {
	type: "init";
	cacheDir?: string;
}

interface EmbedMsg {
	type: "embed";
	id: number;
	texts: string[];
	model: string;
}

type InMsg = InitMsg | EmbedMsg;

let initialized = false;

self.onmessage = async (ev: MessageEvent) => {
	const msg = ev.data as InMsg;
	if (msg.type === "init") {
		if (msg.cacheDir) setEmbeddingCacheDir(msg.cacheDir);
		initialized = true;
		self.postMessage({ type: "init-ok" });
		return;
	}
	if (msg.type === "embed") {
		if (!initialized) {
			self.postMessage({ type: "error", id: msg.id, message: "embed worker received job before init" });
			return;
		}
		try {
			const embeddings = await embed(msg.texts, msg.model, {
				onProgress: (done, total) => self.postMessage({ type: "progress", id: msg.id, done, total }),
			});
			self.postMessage({ type: "result", id: msg.id, embeddings });
		} catch (err) {
			self.postMessage({ type: "error", id: msg.id, message: err instanceof Error ? err.message : String(err) });
		}
	}
};
