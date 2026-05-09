import { createInterface } from "node:readline";
import { asHelpful, isHelpfulError } from "../errors.ts";
import { embed } from "./embedder.ts";

/**
 * Wire-format message exchanged between the parent EmbedderPool and a worker
 * subprocess over the worker's stdin/stdout. Each message is a single JSON
 * object terminated by `\n` — a robust, language-agnostic encoding that
 * survives partial reads on either end. There is no init/ready handshake;
 * the worker lazy-loads the WASM pipeline on its first `embed` request.
 */
interface EmbedRequest {
	type: "embed";
	id: number;
	model: string;
	texts: string[];
}

interface EmbedResponse {
	type: "embed-response";
	id: number;
	vectors?: number[][];
	error?: { kind: string; message: string; hint: string };
}

/** Atomic JSON-line write to stdout — the protocol channel back to the parent. */
function send(msg: EmbedResponse): void {
	process.stdout.write(`${JSON.stringify(msg)}\n`);
}

/**
 * Drive the embed-worker subprocess: read newline-delimited JSON requests
 * from stdin, dispatch them to the local `embed()` (which uses the WASM
 * pipeline), and write JSON responses to stdout. Diagnostics (logger output)
 * go to stderr, so the protocol channel on stdout stays clean.
 *
 * The worker exits naturally when stdin closes (parent died or sent EOF).
 */
export async function runEmbedWorker(): Promise<void> {
	const rl = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
	for await (const line of rl) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let req: EmbedRequest;
		try {
			req = JSON.parse(trimmed) as EmbedRequest;
		} catch {
			// A malformed line on stdin is almost certainly a bug in the parent —
			// log to stderr and keep the worker alive so the parent's other
			// requests still get served.
			process.stderr.write(`embed-worker: ignoring malformed stdin line: ${trimmed.slice(0, 200)}\n`);
			continue;
		}
		if (req.type !== "embed") continue;
		await handleEmbed(req);
	}
}

/** Run one embed request and reply with vectors or a serialisable error. */
async function handleEmbed(req: EmbedRequest): Promise<void> {
	try {
		const vectors = await embed(req.texts, req.model);
		send({ type: "embed-response", id: req.id, vectors });
	} catch (err) {
		const helpful = isHelpfulError(err)
			? err
			: asHelpful(err, "in embed worker", "Inspect the parent process stderr for the full stack trace.");
		send({
			type: "embed-response",
			id: req.id,
			error: { kind: helpful.kind, message: helpful.message, hint: helpful.hint },
		});
	}
}
