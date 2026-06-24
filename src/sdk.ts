// SDK entrypoint for embedding membot in other apps. Exports the high-level
// MembotClient class for most callers, plus the lower-level surfaces —
// context, errors, operations, search, ingest, refresh — for callers that
// need to bypass the client. Most users want MembotClient.

export type { MembotClientOptions } from "./client.ts";
export { MembotClient } from "./client.ts";
export { loadConfig, saveConfig } from "./config/loader.ts";
export type { ChunkerConfig, LlmConfig, MembotConfig } from "./config/schemas.ts";
export { defaultMembotHome, EMBEDDING_DIMENSION, EMBEDDING_MODEL } from "./constants.ts";
export type { AppContext, BuildContextOptions } from "./context.ts";
export { buildContext, closeContext } from "./context.ts";
export type { ErrorKind, HelpfulErrorArgs } from "./errors.ts";
export { asHelpful, HelpfulError, isHelpfulError, mapKindToExit } from "./errors.ts";
export type { Chunk } from "./ingest/chunker.ts";
export { chunkDeterministic } from "./ingest/chunker.ts";
export { embed, embedSingle, setEmbeddingCacheDir } from "./ingest/embedder.ts";
export type { FetchedRemote, FetchOptions } from "./ingest/fetcher.ts";
export { fetchRemote } from "./ingest/fetcher.ts";
export type { IngestCallbacks, IngestEntryResult, IngestInput, IngestResult } from "./ingest/ingest.ts";
export { countResolvedEntries, ingest, ingestResolved } from "./ingest/ingest.ts";
export type { ResolvedLocalEntry, ResolvedSource } from "./ingest/source-resolver.ts";
export { resolveSource } from "./ingest/source-resolver.ts";
export { SERVER_INSTRUCTIONS } from "./mcp/instructions.ts";
export { buildMcpServer, startHttpServer, startStdioServer } from "./mcp/server.ts";
export { OPERATIONS } from "./operations/index.ts";
export type { CliMetadata, Operation } from "./operations/types.ts";
export { composeDescription, defaultCliName, defineOperation } from "./operations/types.ts";
export { refreshOne } from "./refresh/runner.ts";
export { runDueRefreshes, startDaemon } from "./refresh/scheduler.ts";
export { fuseRRF } from "./search/hybrid.ts";
export { searchKeyword } from "./search/keyword.ts";
export { searchSemantic } from "./search/semantic.ts";
