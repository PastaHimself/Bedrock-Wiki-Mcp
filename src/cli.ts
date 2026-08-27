import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
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

const HELP = `Bedrock Wiki MCP ${SERVICE_VERSION}

Usage:
  bedrock-mcp serve                                  Start the HTTP MCP server using the existing read-only index
  bedrock-mcp rebuild-index [directory]              Rebuild the local curated knowledge index
  bedrock-mcp rebuild-sources [checkout-root]        Rebuild from configured official source checkouts
                         [--include-preview]          Include preview sources disabled by default
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
`;

function indexPath(dataDir: string): string {
  return join(dataDir, "index", "bedrock.db");
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

async function rebuildSources(args: readonly string[]): Promise<number> {
  const includePreview = args.includes("--include-preview");
  const unknownFlags = args.filter((arg) => arg.startsWith("--") && arg !== "--include-preview");
  if (unknownFlags.length > 0) throw new Error(`Unknown rebuild-sources option: ${unknownFlags[0]}`);
  const positional = args.filter((arg) => !arg.startsWith("--"));
  if (positional.length > 1) throw new Error("rebuild-sources accepts at most one checkout-root argument");

  const config = loadRuntimeConfig();
  const checkoutRoot = positional[0] ? resolve(process.cwd(), positional[0]) : undefined;
  const result = await rebuildConfiguredSourcesIndex({
    dataDir: config.dataDir,
    includePreview,
    ...(checkoutRoot ? { checkoutRoot } : {}),
  });
  const documents = result.sources.reduce((sum, source) => sum + source.documents, 0);
  const chunks = result.sources.reduce((sum, source) => sum + source.chunks, 0);
  process.stdout.write(
    `Indexed ${result.sources.length} sources, ${documents} documents, ${chunks} chunks into ${result.targetPath}.\n`,
  );
  return 0;
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
  const server = createHttpServer({ database, config });
  try {
    await listen(server, config);
  } catch (error) {
    database.close();
    throw error;
  }

  process.stdout.write(
    `${SERVICE_NAME} listening on http://${config.host}:${config.port}${MCP_PATH}\n`,
  );

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    process.stdout.write(`Received ${signal}; shutting down.\n`);
    try {
      await close(server);
    } finally {
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

  if (command === "rebuild-index") return rebuildIndex(args[1]);
  if (command === "rebuild-sources") return rebuildSources(args.slice(1));
  if (command === "validate-index") return validateIndexCommand();
  if (command === "serve") return serve();

  process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
  return 2;
}
