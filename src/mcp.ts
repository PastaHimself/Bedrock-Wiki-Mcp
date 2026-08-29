import type { DatabaseSync } from "node:sqlite";
import { McpServer } from "@modelcontextprotocol/server";
import type { LocalLlm } from "./ai/local-llm.js";
import { SERVICE_NAME, SERVICE_VERSION } from "./constants.js";
import type { SemanticRetriever } from "./semantic/retriever.js";
import { registerKnowledgeTools } from "./tools/register.js";

export function createBedrockMcpServer(
  database?: DatabaseSync,
  semantic?: SemanticRetriever,
  semanticTopK = 40,
  localLlm?: LocalLlm,
  localLlmRetrievalLimit = 6,
): McpServer {
  const server = new McpServer({
    name: SERVICE_NAME,
    version: SERVICE_VERSION,
  });
  registerKnowledgeTools(server, database, semantic, semanticTopK, localLlm, localLlmRetrievalLimit);
  return server;
}
