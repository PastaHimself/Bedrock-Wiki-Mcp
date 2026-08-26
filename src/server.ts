import { createServer, type Server, type ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { toNodeHandler, type NodeIncomingMessageLike } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import type { AppConfig } from "./config.js";
import { HEALTH_PATH, MCP_PATH, SERVICE_NAME, SERVICE_VERSION } from "./constants.js";
import { createBedrockMcpServer } from "./mcp.js";

export interface HttpServerOptions {
  database?: DatabaseSync;
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

export function createHttpServer(options: HttpServerOptions = {}): Server {
  const mcpHandler = createMcpHandler(() => createBedrockMcpServer(options.database));
  const nodeMcpHandler = toNodeHandler(mcpHandler);

  return createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");

    if (url.pathname === HEALTH_PATH && request.method === "GET") {
      writeJson(response, 200, {
        status: "ok",
        service: SERVICE_NAME,
        version: SERVICE_VERSION,
      });
      return;
    }

    if (url.pathname === MCP_PATH) {
      try {
        // @modelcontextprotocol/node is explicitly designed for Node IncomingMessage.
        // Its duck type and @types/node disagree under exactOptionalPropertyTypes,
        // so keep the compatibility assertion isolated at this adapter boundary.
        await nodeMcpHandler(request as unknown as NodeIncomingMessageLike, response);
      } catch (error) {
        console.error("MCP request failed", error);
        if (!response.headersSent) {
          writeJson(response, 500, { error: "internal_server_error" });
        } else {
          response.end();
        }
      }
      return;
    }

    writeJson(response, 404, { error: "not_found" });
  });
}

export async function listen(server: Server, config: AppConfig): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const onError = (error: Error): void => {
      rejectPromise(error);
    };

    server.once("error", onError);
    server.listen(config.port, config.host, () => {
      server.off("error", onError);
      resolvePromise();
    });
  });
}

export async function close(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }

  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.close((error) => {
      if (error) {
        rejectPromise(error);
        return;
      }
      resolvePromise();
    });
  });
}
