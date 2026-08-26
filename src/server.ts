import { createServer, type Server, type ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { toNodeHandler, type NodeIncomingMessageLike } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { loadConfig, type AppConfig } from "./config.js";
import { HEALTH_PATH, MCP_PATH, SERVICE_NAME, SERVICE_VERSION } from "./constants.js";
import { HttpRequestGuard, type GuardRejection } from "./http/security.js";
import { createBedrockMcpServer } from "./mcp.js";

export interface HttpServerOptions {
  database?: DatabaseSync;
  config?: AppConfig;
}

const handlers = new WeakMap<Server, ReturnType<typeof createMcpHandler>>();

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.end(JSON.stringify(body));
}

function writeGuardRejection(response: ServerResponse, rejection: GuardRejection): void {
  if (rejection.statusCode === 401) response.setHeader("www-authenticate", "Bearer");
  if (rejection.retryAfterSeconds !== undefined) response.setHeader("retry-after", String(rejection.retryAfterSeconds));
  writeJson(response, rejection.statusCode, { error: rejection.error });
}

export function createHttpServer(options: HttpServerOptions = {}): Server {
  const config = options.config ?? loadConfig({ NODE_ENV: "test" });
  const guard = new HttpRequestGuard(config);
  const mcpHandler = createMcpHandler(
    () => createBedrockMcpServer(options.database),
    {
      legacy: "stateless",
      responseMode: "auto",
      maxRequestBodySize: config.maxRequestBodySize,
      onerror: (error) => console.error("MCP transport error", error),
    },
  );
  const nodeMcpHandler = toNodeHandler(mcpHandler);

  const server = createServer(async (request, response) => {
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
      const permit = guard.enter(request);
      if ("statusCode" in permit) {
        writeGuardRejection(response, permit);
        return;
      }

      try {
        response.setHeader("cache-control", "no-store");
        response.setHeader("x-content-type-options", "nosniff");
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
      } finally {
        permit.release();
      }
      return;
    }

    writeJson(response, 404, { error: "not_found" });
  });

  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  handlers.set(server, mcpHandler);
  return server;
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
  const handler = handlers.get(server);
  if (handler) {
    await handler.close();
    handlers.delete(server);
  }

  if (server.listening) {
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
}
