import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../../src/config.js";
import { close, createHttpServer, listen } from "../../src/server.js";

const openServers: ReturnType<typeof createHttpServer>[] = [];

const config: AppConfig = {
  nodeEnv: "test",
  host: "127.0.0.1",
  port: 0,
  dataDir: "/tmp/bedrock-mcp-test",
  logLevel: "error",
  allowedHosts: [],
  allowedOrigins: [],
  maxRequestBodySize: 524288,
  maxConcurrentRequests: 32,
  rateLimitPerMinute: 120,
};

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => close(server)));
});

describe("Streamable HTTP MCP transport", () => {
  it("serves a stateless 2025-era initialize exchange for compatibility", async () => {
    const server = createHttpServer({ config });
    openServers.push(server);
    await listen(server, config);
    const address = server.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          clientInfo: { name: "integration-test", version: "1.0.0" },
          protocolVersion: "2025-06-18",
          capabilities: {},
        },
        id: "init-1",
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("mcp-session-id")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.text();
    expect(body).toContain("bedrock-wiki-mcp");
    expect(body).toContain("0.1.0");
  });
});
