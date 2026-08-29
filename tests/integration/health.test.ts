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
    trustedProxyIps: [],
    maxRequestBodySize: 524288,
    maxConcurrentRequests: 32,
    rateLimitPerMinute: 120,
    semanticEnabled: false,
    semanticModel: "onnx-community/all-MiniLM-L6-v2-ONNX",
    semanticTopK: 40,
    localLlmEnabled: false,
    localLlmBaseUrl: "http://127.0.0.1:8081/v1",
    localLlmModel: "Qwen/Qwen3-1.7B-GGUF:Q8_0",
    localLlmTimeoutMs: 60000,
    localLlmMaxTokens: 512,
    localLlmRetrievalLimit: 6,
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => close(server)));
});

describe("HTTP server", () => {
  it("allows the local model timeout to complete before the HTTP request expires", () => {
    const server = createHttpServer({ config: testConfig({ localLlmTimeoutMs: 45000 }) });
    openServers.push(server);

    expect(server.requestTimeout).toBe(55000);
  });

  it("serves a minimal unauthenticated health response", async () => {
    const config = testConfig({ bearerToken: "0123456789abcdef" });
    const server = createHttpServer({ config });
    openServers.push(server);
    await listen(server, config);

    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/health`);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      status: "ok",
      service: "bedrock-wiki-mcp",
      version: "0.1.0",
    });
  });
});
