import { loadRuntimeConfig } from "./config.js";
import { MCP_PATH, SERVICE_NAME, SERVICE_VERSION } from "./constants.js";
import { close, createHttpServer, listen } from "./server.js";

const HELP = `Bedrock Wiki MCP ${SERVICE_VERSION}

Usage:
  bedrock-mcp serve      Start the HTTP MCP server
  bedrock-mcp version    Print the version
  bedrock-mcp help       Show this help

Environment:
  BEDROCK_MCP_HOST       Bind host (default: 127.0.0.1)
  BEDROCK_MCP_PORT       Bind port (default: 8080)
  BEDROCK_MCP_DATA_DIR   Persistent data directory (default: ./data)
  BEDROCK_MCP_LOG_LEVEL  debug | info | warn | error
`;

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

  if (command !== "serve") {
    process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
    return 2;
  }

  const config = loadRuntimeConfig();
  const server = createHttpServer(config);
  await listen(server, config);

  process.stdout.write(
    `${SERVICE_NAME} listening on http://${config.host}:${config.port}${MCP_PATH}\n`,
  );

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) {
      return;
    }
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
