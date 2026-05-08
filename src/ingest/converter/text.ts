/**
 * Plain-text / markdown passthrough converter. Decodes bytes as UTF-8 and
 * returns them unchanged — the chunker downstream handles paragraph
 * boundaries the same way as it would for an LLM-converted file.
 */
export function convertText(bytes: Uint8Array): string {
	return new TextDecoder("utf-8").decode(bytes);
}
