import { McpServer } from "@modelcontextprotocol/server";
import { SERVICE_NAME, SERVICE_VERSION } from "./constants.js";

export function createBedrockMcpServer(): McpServer {
  return new McpServer({
    name: SERVICE_NAME,
    version: SERVICE_VERSION,
  });
}
