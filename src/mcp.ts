import type { DatabaseSync } from "node:sqlite";
import { McpServer } from "@modelcontextprotocol/server";
import { SERVICE_NAME, SERVICE_VERSION } from "./constants.js";
import { registerKnowledgeTools } from "./tools/register.js";

export function createBedrockMcpServer(database?: DatabaseSync): McpServer {
  const server = new McpServer({
    name: SERVICE_NAME,
    version: SERVICE_VERSION,
  });
  registerKnowledgeTools(server, database);
  return server;
}
