import { join, resolve } from "node:path";
import { loadRuntimeConfig } from "./config.js";
import { MCP_PATH, SERVICE_NAME, SERVICE_VERSION } from "./constants.js";
import { openDatabase } from "./db/connection.js";
import { rebuildLocalIndex } from "./db/indexer.js";
import { migrateDatabase } from "./db/migrate.js";
import { validateIndex } from "./db/validate.js";
import type { SourceDescriptor } from "./models/source.js";
import { close, createHttpServer, listen } from "./server.js";

const HELP = `Bedrock Wiki MCP ${SERVICE_VERSION}

Usage:
  bedrock-mcp serve                       Start the HTTP MCP server
  bedrock-mcp rebuild-index [directory]   Rebuild the local knowledge index
  bedrock-mcp validate-index              Validate SQLite/index integrity
  bedrock-mcp version                     Print the version
  bedrock-mcp help                        Show this help

Environment:
  BEDROCK_MCP_HOST       Bind host (default: 127.0.0.1)
  BEDROCK_MCP_PORT       Bind port (default: 8080)
  BEDROCK_MCP_DATA_DIR   Persistent data directory (default: ./data)
  BEDROCK_MCP_LOG_LEVEL  debug | info | warn | error
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

async function serve(): Promise<number> {
  const config = loadRuntimeConfig();
  const server = createHttpServer();
  await listen(server, config);

  process.stdout.write(
    `${SERVICE_NAME} listening on http://${config.host}:${config.port}${MCP_PATH}\n`,
  );

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    process.stdout.write(`Received ${signal}; shutting down.\n`);
    await close(server);
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
  if (command === "validate-index") return validateIndexCommand();
  if (command === "serve") return serve();

  process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
  return 2;
}
