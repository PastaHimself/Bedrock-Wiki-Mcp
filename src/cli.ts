import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createBackup } from "./admin/backup.js";
import { formatBenchmarkSummary, loadBenchmarkSuite, runBenchmark } from "./admin/benchmark.js";
import { formatIndexStatus, readIndexStatus } from "./admin/status.js";
import { LocalLlmClient } from "./ai/local-llm.js";
import { tryStartLocalLlmServer, type LocalLlmServerHandle } from "./ai/local-server.js";
import { loadRuntimeConfig } from "./config.js";
import { MCP_PATH, SERVICE_NAME, SERVICE_VERSION } from "./constants.js";
import { openDatabase } from "./db/connection.js";
import { rebuildLocalIndex } from "./db/indexer.js";
import { getSchemaVersion, migrateDatabase } from "./db/migrate.js";
import { SCHEMA_VERSION } from "./db/migrations/0001-initial.js";
import { rebuildConfiguredSourcesIndex } from "./db/source-indexer.js";
import { validateIndex } from "./db/validate.js";
import type { SourceDescriptor } from "./models/source.js";
import { close, createHttpServer, listen } from "./server.js";
import { rebuildSemanticIndex } from "./semantic/builder.js";
import { coreSemanticFingerprint } from "./semantic/database.js";
import { TransformersEmbedder } from "./semantic/embedder.js";
import { initializeOptionalSemantic } from "./semantic/optional.js";
import { openSemanticRetriever, type SqliteSemanticRetriever } from "./semantic/retriever.js";
import { syncNpmSources } from "./sources/npm.js";
import { syncConfiguredSources } from "./sources/sync.js";

const HELP = `Bedrock Wiki MCP ${SERVICE_VERSION}

Usage:
  bedrock-mcp serve                                  Start the HTTP MCP server using the existing read-only index
  bedrock-mcp sync-sources [checkout-root]           Clone/fetch configured source checkouts and npm metadata
                         [--include-preview]          Include preview sources disabled by default
  bedrock-mcp rebuild-index [directory]              Rebuild the local curated knowledge index
  bedrock-mcp rebuild-sources [checkout-root]        Rebuild from configured official source snapshots
                         [--include-preview]          Include preview sources disabled by default
  bedrock-mcp build-semantic-index                   Build optional local vector index from bedrock.db
  bedrock-mcp status [--json]                        Show index health, counts, revisions, and source coverage
  bedrock-mcp backup [destination] [--retain=N]      Create online SQLite/config/local-knowledge backup
  bedrock-mcp benchmark [file] [--json]              Run retrieval quality benchmark (default: benchmarks/search-queries.json)
  bedrock-mcp validate-index                         Validate SQLite/index integrity
  bedrock-mcp version                                Print the version
  bedrock-mcp help                                   Show this help

Environment:
  BEDROCK_MCP_HOST                     Bind host (default: 127.0.0.1)
  BEDROCK_MCP_PORT                     Bind port (default: 8080)
  BEDROCK_MCP_DATA_DIR                 Persistent data directory (default: ./data)
  BEDROCK_MCP_LOG_LEVEL                debug | info | warn | error
  BEDROCK_MCP_ALLOWED_HOSTS            Comma-separated Host header allowlist
  BEDROCK_MCP_ALLOWED_ORIGINS          Comma-separated Origin allowlist
  BEDROCK_MCP_BEARER_TOKEN             Optional bearer token (minimum 16 characters)
  BEDROCK_MCP_MAX_REQUEST_BYTES        MCP request-body limit (default: 524288)
  BEDROCK_MCP_MAX_CONCURRENT_REQUESTS  Concurrent /mcp request cap (default: 32)
  BEDROCK_MCP_RATE_LIMIT_PER_MINUTE    Per-client request cap (default: 120)
  BEDROCK_MCP_INCLUDE_PREVIEW          true | false for source sync/rebuild (default: false)
  BEDROCK_MCP_SEMANTIC_ENABLED         true | false (default: false)
  BEDROCK_MCP_SEMANTIC_MODEL           Local Transformers.js embedding model id
  BEDROCK_MCP_SEMANTIC_TOP_K           Semantic candidate count (default: 40)
  BEDROCK_MCP_LOCAL_LLM_ENABLED        true | false; enables ask_bedrock (default: true)
  BEDROCK_MCP_LOCAL_LLM_BASE_URL       Loopback llama-server API (default: http://127.0.0.1:8081/v1)
  BEDROCK_MCP_LOCAL_LLM_BINARY          llama-server executable (default: llama-server)
  BEDROCK_MCP_LOCAL_LLM_MODEL          Model id (default: Qwen/Qwen3-1.7B-GGUF:Q8_0)
  BEDROCK_MCP_LOCAL_LLM_STARTUP_TIMEOUT_MS Model download/startup timeout (default: 900000)
  BEDROCK_MCP_LOCAL_LLM_TIMEOUT_MS     Inference timeout in milliseconds (default: 60000)
  BEDROCK_MCP_LOCAL_LLM_MAX_TOKENS     Generation limit (default: 512; max: 512)
  BEDROCK_MCP_LOCAL_LLM_RETRIEVAL_LIMIT Maximum evidence resources (default: 6)
`;

function indexPath(dataDir: string): string {
  return join(dataDir, "index", "bedrock.db");
}

function semanticIndexPath(dataDir: string): string {
  return join(dataDir, "index", "semantic.db");
}

function semanticModelCachePath(dataDir: string): string {
  return join(dataDir, "models");
}

function localLlmCachePath(dataDir: string): string {
  return join(dataDir, "models", "huggingface");
}

function sourceCommandArguments(command: string, args: readonly string[]): { includePreview: boolean; checkoutRoot?: string } {
  const includePreview = args.includes("--include-preview");
  const unknownFlags = args.filter((arg) => arg.startsWith("--") && arg !== "--include-preview");
  if (unknownFlags.length > 0) throw new Error(`Unknown ${command} option: ${unknownFlags[0]}`);
  const positional = args.filter((arg) => !arg.startsWith("--"));
  if (positional.length > 1) throw new Error(`${command} accepts at most one checkout-root argument`);
  return {
    includePreview,
    ...(positional[0] ? { checkoutRoot: resolve(process.cwd(), positional[0]) } : {}),
  };
}

async function rebuildIndex(directoryArg: string | undefined): Promise<number> {
  const config = loadRuntimeConfig();
  const database = openDatabase(indexPath(config.dataDir));
  try {
    migrateDatabase(database);
    const directory = resolve(process.cwd(), directoryArg ?? "knowledge/local");
    const source: SourceDescriptor = {
      id: "local_curated",
      name: "Local curated knowledge",
      tier: 3,
      channel: "stable",
      sourceType: "local",
      revision: "local",
    };
    const result = await rebuildLocalIndex(database, { directory, source });
    process.stdout.write(
      `Indexed ${result.documentsIndexed} documents, ${result.chunksIndexed} chunks, ${result.validation.identifiers} identifiers.\n`,
    );
    return 0;
  } finally {
    database.close();
  }
}

async function syncSources(args: readonly string[]): Promise<number> {
  const parsed = sourceCommandArguments("sync-sources", args);
  const config = loadRuntimeConfig();
  const includePreview = parsed.includePreview || config.includePreview || false;
  const result = await syncConfiguredSources({
    dataDir: config.dataDir,
    includePreview,
    ...(parsed.checkoutRoot ? { checkoutRoot: parsed.checkoutRoot } : {}),
  });

  for (const source of result.sources) {
    const previous = source.previousRevision ? ` ${source.previousRevision.slice(0, 12)} ->` : "";
    process.stdout.write(
      `${source.sourceId}: ${source.status}${previous} ${source.revision.slice(0, 12)} (${source.branch})\n`,
    );
  }

  const npmSources = await syncNpmSources({ dataDir: config.dataDir, includePreview });
  for (const source of npmSources) {
    process.stdout.write(
      `${source.sourceId}: ${source.status} ${source.revision.slice(0, 12)} (${source.packages} packages, ${source.tags} dist-tags)\n`,
    );
  }
  process.stdout.write(`Synchronized ${result.sources.length + npmSources.length} sources under ${result.checkoutRoot} and ${config.dataDir}.\n`);
  return 0;
}

async function rebuildSources(args: readonly string[]): Promise<number> {
  const parsed = sourceCommandArguments("rebuild-sources", args);
  const config = loadRuntimeConfig();
  const includePreview = parsed.includePreview || config.includePreview || false;
  const result = await rebuildConfiguredSourcesIndex({
    dataDir: config.dataDir,
    includePreview,
    ...(parsed.checkoutRoot ? { checkoutRoot: parsed.checkoutRoot } : {}),
  });
  const documents = result.sources.reduce((sum, source) => sum + source.documents, 0);
  const chunks = result.sources.reduce((sum, source) => sum + source.chunks, 0);
  process.stdout.write(
    `Indexed ${result.sources.length} sources, ${documents} documents, ${chunks} chunks, ${result.aliasesDerived} derived aliases into ${result.targetPath}.\n`,
  );
  return 0;
}

async function buildSemanticIndex(): Promise<number> {
  const config = loadRuntimeConfig();
  const database = openServingDatabase(indexPath(config.dataDir));
  const cacheDir = semanticModelCachePath(config.dataDir);
  await mkdir(cacheDir, { recursive: true });
  try {
    const embedder = new TransformersEmbedder(config.semanticModel, {
      cacheDir,
      allowRemoteModels: true,
    });
    const result = await rebuildSemanticIndex(database, semanticIndexPath(config.dataDir), embedder);
    process.stdout.write(
      `Embedded ${result.chunksEmbedded} chunks with ${result.model} (${result.dimensions} dimensions) into ${result.targetPath}.\n`,
    );
    return 0;
  } finally {
    database.close();
  }
}

async function statusCommand(args: readonly string[]): Promise<number> {
  const json = args.includes("--json");
  const unknown = args.filter((arg) => arg !== "--json");
  if (unknown.length > 0) throw new Error(`Unknown status option: ${unknown[0]}`);
  const config = loadRuntimeConfig();
  const path = indexPath(config.dataDir);
  const database = openServingDatabase(path);
  try {
    const report = await readIndexStatus(database, path);
    process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : formatIndexStatus(report));
    return report.validation.ok ? 0 : 1;
  } finally {
    database.close();
  }
}

function backupArguments(args: readonly string[]): { destinationRoot?: string; retain?: number } {
  const positional = args.filter((arg) => !arg.startsWith("--"));
  if (positional.length > 1) throw new Error("backup accepts at most one destination argument");
  let retain: number | undefined;
  for (const arg of args.filter((value) => value.startsWith("--"))) {
    const match = /^--retain=(\d+)$/.exec(arg);
    if (!match?.[1]) throw new Error(`Unknown backup option: ${arg}`);
    retain = Number(match[1]);
  }
  return {
    ...(positional[0] ? { destinationRoot: resolve(process.cwd(), positional[0]) } : {}),
    ...(retain !== undefined ? { retain } : {}),
  };
}

async function backupCommand(args: readonly string[]): Promise<number> {
  const parsed = backupArguments(args);
  const config = loadRuntimeConfig();
  const result = await createBackup({
    dataDir: config.dataDir,
    projectRoot: process.cwd(),
    ...(parsed.destinationRoot ? { destinationRoot: parsed.destinationRoot } : {}),
    ...(parsed.retain !== undefined ? { retain: parsed.retain } : {}),
  });
  process.stdout.write(`Backup created at ${result.directory} (${result.files.length} files).\n`);
  if (result.removedBackups.length > 0) {
    process.stdout.write(`Pruned ${result.removedBackups.length} old backup(s): ${result.removedBackups.join(", ")}\n`);
  }
  return 0;
}

async function benchmarkCommand(args: readonly string[]): Promise<number> {
  const json = args.includes("--json");
  const unknownFlags = args.filter((arg) => arg.startsWith("--") && arg !== "--json");
  if (unknownFlags.length > 0) throw new Error(`Unknown benchmark option: ${unknownFlags[0]}`);
  const positional = args.filter((arg) => !arg.startsWith("--"));
  if (positional.length > 1) throw new Error("benchmark accepts at most one benchmark-file argument");
  const suitePath = resolve(process.cwd(), positional[0] ?? "benchmarks/search-queries.json");
  const suite = await loadBenchmarkSuite(suitePath);
  const config = loadRuntimeConfig();
  const database = openServingDatabase(indexPath(config.dataDir));
  try {
    const summary = runBenchmark(database, suite);
    process.stdout.write(json ? `${JSON.stringify(summary, null, 2)}\n` : formatBenchmarkSummary(summary));
    return summary.passedTargets ? 0 : 1;
  } finally {
    database.close();
  }
}

function validateIndexCommand(): number {
  const config = loadRuntimeConfig();
  const database = openDatabase(indexPath(config.dataDir));
  try {
    migrateDatabase(database);
    const report = validateIndex(database);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.ok ? 0 : 1;
  } finally {
    database.close();
  }
}

function openServingDatabase(path: string): DatabaseSync {
  let database: DatabaseSync;
  try {
    database = openDatabase(path, { mode: "readonly" });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Knowledge index is unavailable at ${path}. Build the index before serving. ${detail}`);
  }

  const schemaVersion = getSchemaVersion(database);
  if (schemaVersion !== SCHEMA_VERSION) {
    database.close();
    throw new Error(`Knowledge index schema ${schemaVersion} is incompatible with server schema ${SCHEMA_VERSION}. Rebuild or migrate the index before serving.`);
  }
  return database;
}

async function serve(): Promise<number> {
  const config = loadRuntimeConfig();
  const database = openServingDatabase(indexPath(config.dataDir));
  const semantic = await initializeOptionalSemantic<SqliteSemanticRetriever>(
    config.semanticEnabled,
    async () => {
      const embedder = new TransformersEmbedder(config.semanticModel, {
        cacheDir: semanticModelCachePath(config.dataDir),
        allowRemoteModels: false,
      });
      await embedder.embed(["minecraft bedrock semantic startup"]);
      return openSemanticRetriever(
        semanticIndexPath(config.dataDir),
        embedder,
        coreSemanticFingerprint(database),
        config.semanticTopK,
      );
    },
    (message) => process.stderr.write(`${message}\n`),
  );

  let localLlmProcess: LocalLlmServerHandle | undefined;
  let server: ReturnType<typeof createHttpServer> | undefined;
  try {
    if (config.localLlmEnabled) {
      localLlmProcess = await tryStartLocalLlmServer({
        baseUrl: config.localLlmBaseUrl,
        model: config.localLlmModel,
        binary: config.localLlmBinary,
        cacheDir: localLlmCachePath(config.dataDir),
        startupTimeoutMs: config.localLlmStartupTimeoutMs,
      }, (error) => {
        process.stderr.write(
          `Local Qwen helper unavailable; the MCP will continue without local answers: ${error.message}\n`,
        );
      });
    }
    const localLlm = config.localLlmEnabled
      ? new LocalLlmClient({
        baseUrl: config.localLlmBaseUrl,
        model: config.localLlmModel,
        timeoutMs: config.localLlmTimeoutMs,
        maxTokens: config.localLlmMaxTokens,
      })
      : undefined;
    server = createHttpServer({
      database,
      config,
      ...(semantic ? { semantic } : {}),
      ...(localLlm ? { localLlm } : {}),
    });
    await listen(server, config);
  } catch (error) {
    if (server) await close(server).catch(() => undefined);
    await localLlmProcess?.stop();
    semantic?.close();
    database.close();
    throw error;
  }

  process.stdout.write(
    `${SERVICE_NAME} listening on http://${config.host}:${config.port}${MCP_PATH}${semantic ? " with semantic search" : ""}\n`,
  );

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    process.stdout.write(`Received ${signal}; shutting down.\n`);
    try {
      await close(server);
    } finally {
      await localLlmProcess?.stop();
      semantic?.close();
      database.close();
    }
  };

  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });

  return 0;
}

export async function runCli(args: readonly string[] = process.argv.slice(2)): Promise<number> {
  const command = args[0] ?? "serve";

  if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(HELP);
    return 0;
  }

  if (command === "version" || command === "--version" || command === "-v") {
    process.stdout.write(`${SERVICE_VERSION}\n`);
    return 0;
  }

  if (command === "sync-sources") return syncSources(args.slice(1));
  if (command === "rebuild-index") return rebuildIndex(args[1]);
  if (command === "rebuild-sources") return rebuildSources(args.slice(1));
  if (command === "build-semantic-index") return buildSemanticIndex();
  if (command === "status") return statusCommand(args.slice(1));
  if (command === "backup") return backupCommand(args.slice(1));
  if (command === "benchmark") return benchmarkCommand(args.slice(1));
  if (command === "validate-index") return validateIndexCommand();
  if (command === "serve") return serve();

  process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
  return 2;
}
