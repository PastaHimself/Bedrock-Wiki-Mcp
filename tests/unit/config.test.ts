import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";

describe("loadConfig", () => {
  it("uses safe local defaults", () => {
    const config = loadConfig({}, "/srv/bedrock-mcp");

    expect(config).toEqual({
      nodeEnv: "development",
      host: "127.0.0.1",
      port: 8080,
      dataDir: "/srv/bedrock-mcp/data",
      logLevel: "info",
      allowedHosts: [],
      allowedOrigins: [],
      maxRequestBodySize: 524288,
      maxConcurrentRequests: 32,
      rateLimitPerMinute: 120,
    });
  });

  it("parses deployment and security overrides", () => {
    const config = loadConfig(
      {
        NODE_ENV: "production",
        BEDROCK_MCP_HOST: "0.0.0.0",
        BEDROCK_MCP_PORT: "3000",
        BEDROCK_MCP_DATA_DIR: "/home/container/data",
        BEDROCK_MCP_LOG_LEVEL: "warn",
        BEDROCK_MCP_ALLOWED_HOSTS: "bedrock-mcp.example.com, BEDROCK-MCP.EXAMPLE.COM:8443",
        BEDROCK_MCP_ALLOWED_ORIGINS: "https://chatgpt.com/, https://example.com",
        BEDROCK_MCP_BEARER_TOKEN: "0123456789abcdef",
        BEDROCK_MCP_MAX_REQUEST_BYTES: "262144",
        BEDROCK_MCP_MAX_CONCURRENT_REQUESTS: "12",
        BEDROCK_MCP_RATE_LIMIT_PER_MINUTE: "90",
      },
      "/ignored",
    );

    expect(config).toEqual({
      nodeEnv: "production",
      host: "0.0.0.0",
      port: 3000,
      dataDir: "/home/container/data",
      logLevel: "warn",
      allowedHosts: ["bedrock-mcp.example.com", "bedrock-mcp.example.com:8443"],
      allowedOrigins: ["https://chatgpt.com", "https://example.com"],
      bearerToken: "0123456789abcdef",
      maxRequestBodySize: 262144,
      maxConcurrentRequests: 12,
      rateLimitPerMinute: 90,
    });
  });

  it.each(["0", "65536", "not-a-port"])("rejects invalid port %s", (port) => {
    expect(() => loadConfig({ BEDROCK_MCP_PORT: port })).toThrow();
  });

  it("rejects weak bearer tokens and unsafe request limits", () => {
    expect(() => loadConfig({ BEDROCK_MCP_BEARER_TOKEN: "too-short" })).toThrow();
    expect(() => loadConfig({ BEDROCK_MCP_MAX_REQUEST_BYTES: "100" })).toThrow();
    expect(() => loadConfig({ BEDROCK_MCP_MAX_CONCURRENT_REQUESTS: "0" })).toThrow();
  });
});
