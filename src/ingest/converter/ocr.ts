import { logger } from "../../output/logger.ts";

interface TesseractWorker {
	recognize(input: Uint8Array | Buffer | string): Promise<{ data: { text: string } }>;
	terminate(): Promise<void>;
}

let workerPromise: Promise<TesseractWorker> | null = null;

/**
 * Lazily initialize a Tesseract worker for English OCR. Held as a process-
 * wide singleton because spinning a worker up costs hundreds of ms.
 */
async function getWorker(): Promise<TesseractWorker> {
	if (!workerPromise) {
		workerPromise = (async () => {
			const tesseract = await import("tesseract.js");
			const w = await tesseract.createWorker("eng");
			return w as unknown as TesseractWorker;
		})();
	}
	return workerPromise;
}

/**
 * Run Tesseract OCR over the provided bytes (image bytes). Returns the
 * recognized text. Errors are logged and turned into an empty string so
 * the calling pipeline can degrade gracefully.
 */
export async function ocrImage(bytes: Uint8Array): Promise<string> {
	try {
		const worker = await getWorker();
		const result = await worker.recognize(Buffer.from(bytes));
		return (result.data.text ?? "").trim();
	} catch (err) {
		logger.warn(`ocr: recognition failed (${err instanceof Error ? err.message : String(err)})`);
		return "";
	}
}

/** Tear down the singleton worker — call once at process exit if needed. */
export async function shutdownOcr(): Promise<void> {
	if (!workerPromise) return;
	const w = await workerPromise;
	workerPromise = null;
	try {
		await w.terminate();
	} catch {
		// best effort
	}
}
