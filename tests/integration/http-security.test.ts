import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../../src/config.js";
import { close, createHttpServer, listen } from "../../src/server.js";

const openServers: ReturnType<typeof createHttpServer>[] = [];

function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
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
    ...overrides,
  };
}

async function start(config: AppConfig) {
  const server = createHttpServer({ config });
  openServers.push(server);
  await listen(server, config);
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => close(server)));
});

describe("remote HTTP security", () => {
  it("enforces an optional bearer token only on the MCP endpoint", async () => {
    const base = await start(testConfig({ bearerToken: "0123456789abcdef" }));

    const missing = await fetch(`${base}/mcp`, { method: "POST" });
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toBe("Bearer");
    await expect(missing.json()).resolves.toEqual({ error: "unauthorized" });

    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
  });

  it("rejects disallowed Host and Origin headers before MCP dispatch", async () => {
    const hostBase = await start(testConfig({ allowedHosts: ["bedrock-mcp.example.com"] }));
    const hostRejected = await fetch(`${hostBase}/mcp`, { method: "POST" });
    expect(hostRejected.status).toBe(403);
    await expect(hostRejected.json()).resolves.toEqual({ error: "host_not_allowed" });

    const originBase = await start(testConfig({ allowedOrigins: ["https://chatgpt.com"] }));
    const originRejected = await fetch(`${originBase}/mcp`, {
      method: "POST",
      headers: { origin: "https://evil.example" },
    });
    expect(originRejected.status).toBe(403);
    await expect(originRejected.json()).resolves.toEqual({ error: "origin_not_allowed" });
  });

  it("rate limits repeated MCP requests from one client", async () => {
    const base = await start(testConfig({ rateLimitPerMinute: 1 }));

    const first = await fetch(`${base}/mcp`);
    expect(first.status).not.toBe(429);

    const second = await fetch(`${base}/mcp`);
    expect(second.status).toBe(429);
    expect(Number(second.headers.get("retry-after"))).toBeGreaterThan(0);
    await expect(second.json()).resolves.toEqual({ error: "rate_limited" });
  });

  it("rejects oversized MCP request bodies before parsing", async () => {
    const base = await start(testConfig({ maxRequestBodySize: 16_384 }));
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(17_000),
    });

    expect(response.status).toBe(413);
  });
});
