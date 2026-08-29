import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { toNodeHandler, type NodeIncomingMessageLike } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { loadConfig, type AppConfig } from "./config.js";
import { HEALTH_PATH, MCP_PATH, SERVICE_NAME, SERVICE_VERSION } from "./constants.js";
import { HttpRequestGuard, type GuardRejection } from "./http/security.js";
import { createBedrockMcpServer } from "./mcp.js";
import type { SemanticRetriever } from "./semantic/retriever.js";

export interface HttpServerOptions {
  database?: DatabaseSync;
  semantic?: SemanticRetriever;
  semanticTopK?: number;
  /** @deprecated Ignored compatibility field from the removed local-answer runtime. */
  localLlm?: unknown;
  /** @deprecated Ignored compatibility field from the removed local-answer runtime. */
  localLlmRetrievalLimit?: number;
  config?: AppConfig;
}

interface ParsedRequestBody {
  ok: true;
  value?: unknown;
}

interface RequestBodyRejection {
  ok: false;
  statusCode: 400 | 413;
  error: "invalid_json" | "request_too_large";
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

async function readBoundedJsonBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<ParsedRequestBody | RequestBodyRejection> {
  if (request.method?.toUpperCase() !== "POST") return { ok: true };

  const declaredLength = request.headers["content-length"];
  if (typeof declaredLength === "string") {
    const parsedLength = Number(declaredLength);
    if (Number.isFinite(parsedLength) && parsedLength > maxBytes) {
      request.resume();
      return { ok: false, statusCode: 413, error: "request_too_large" };
    }
  }

  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of request) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array);
    received += bytes.byteLength;
    if (received > maxBytes) {
      request.resume();
      return { ok: false, statusCode: 413, error: "request_too_large" };
    }
    chunks.push(bytes);
  }

  if (received === 0) return { ok: true };
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks, received).toString("utf8")) as unknown };
  } catch {
    return { ok: false, statusCode: 400, error: "invalid_json" };
  }
}

export function createHttpServer(options: HttpServerOptions = {}): Server {
  const config = options.config ?? loadConfig({ NODE_ENV: "test" });
  const guard = new HttpRequestGuard(config);
  const mcpHandler = createMcpHandler(
    () => createBedrockMcpServer(
      options.database,
      options.semantic,
      options.semanticTopK ?? config.semanticTopK,
    ),
    {
      legacy: "stateless",
      responseMode: "auto",
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
        const parsedBody = await readBoundedJsonBody(request, config.maxRequestBodySize);
        if (!parsedBody.ok) {
          if (parsedBody.statusCode === 413) response.setHeader("connection", "close");
          writeJson(response, parsedBody.statusCode, { error: parsedBody.error });
          return;
        }

        // @modelcontextprotocol/node is explicitly designed for Node IncomingMessage.
        // Its duck type and @types/node disagree under exactOptionalPropertyTypes,
        // so keep the compatibility assertion isolated at this adapter boundary.
        await nodeMcpHandler(
          request as unknown as NodeIncomingMessageLike,
          response,
          parsedBody.value,
        );
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
