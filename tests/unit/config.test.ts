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
      trustedProxyIps: [],
      maxRequestBodySize: 524288,
      maxConcurrentRequests: 32,
      rateLimitPerMinute: 120,
      includePreview: false,
      semanticEnabled: false,
      semanticModel: "onnx-community/all-MiniLM-L6-v2-ONNX",
      semanticTopK: 40,
      localLlmEnabled: true,
      localLlmBaseUrl: "http://127.0.0.1:8081/v1",
      localLlmBinary: "llama-server",
      localLlmModel: "Qwen/Qwen3-1.7B-GGUF:Q8_0",
      localLlmStartupTimeoutMs: 900000,
      localLlmTimeoutMs: 60000,
      localLlmMaxTokens: 512,
      localLlmRetrievalLimit: 6,
    });
  });

  it("parses deployment, security, source, and semantic overrides", () => {
    const config = loadConfig(
      {
        NODE_ENV: "production",
        BEDROCK_MCP_HOST: "0.0.0.0",
        BEDROCK_MCP_PORT: "3000",
        BEDROCK_MCP_DATA_DIR: "/home/container/data",
        BEDROCK_MCP_LOG_LEVEL: "warn",
        BEDROCK_MCP_ALLOWED_HOSTS: "bedrock-mcp.example.com, BEDROCK-MCP.EXAMPLE.COM:8443",
        BEDROCK_MCP_ALLOWED_ORIGINS: "https://chatgpt.com/, https://example.com",
        BEDROCK_MCP_TRUSTED_PROXY_IPS: "127.0.0.1, ::1,127.0.0.1",
        BEDROCK_MCP_BEARER_TOKEN: "0123456789abcdef",
        BEDROCK_MCP_MAX_REQUEST_BYTES: "262144",
        BEDROCK_MCP_MAX_CONCURRENT_REQUESTS: "12",
        BEDROCK_MCP_RATE_LIMIT_PER_MINUTE: "90",
        BEDROCK_MCP_INCLUDE_PREVIEW: "true",
        BEDROCK_MCP_SEMANTIC_ENABLED: "true",
        BEDROCK_MCP_SEMANTIC_MODEL: "example/model",
        BEDROCK_MCP_SEMANTIC_TOP_K: "25",
        BEDROCK_MCP_LOCAL_LLM_ENABLED: "true",
        BEDROCK_MCP_LOCAL_LLM_BASE_URL: "http://127.0.0.1:9090/v1/",
        BEDROCK_MCP_LOCAL_LLM_BINARY: "/opt/llama-server",
        BEDROCK_MCP_LOCAL_LLM_MODEL: "local/qwen",
        BEDROCK_MCP_LOCAL_LLM_STARTUP_TIMEOUT_MS: "120000",
        BEDROCK_MCP_LOCAL_LLM_TIMEOUT_MS: "45000",
        BEDROCK_MCP_LOCAL_LLM_MAX_TOKENS: "256",
        BEDROCK_MCP_LOCAL_LLM_RETRIEVAL_LIMIT: "4",
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
      trustedProxyIps: ["127.0.0.1", "::1"],
      bearerToken: "0123456789abcdef",
      maxRequestBodySize: 262144,
      maxConcurrentRequests: 12,
      rateLimitPerMinute: 90,
      includePreview: true,
      semanticEnabled: true,
      semanticModel: "example/model",
      semanticTopK: 25,
      localLlmEnabled: true,
      localLlmBaseUrl: "http://127.0.0.1:9090/v1/",
      localLlmBinary: "/opt/llama-server",
      localLlmModel: "local/qwen",
      localLlmStartupTimeoutMs: 120000,
      localLlmTimeoutMs: 45000,
      localLlmMaxTokens: 256,
      localLlmRetrievalLimit: 4,
    });
  });

  it.each(["0", "65536", "not-a-port"])("rejects invalid port %s", (port) => {
    expect(() => loadConfig({ BEDROCK_MCP_PORT: port })).toThrow();
  });

  it("rejects weak bearer tokens and unsafe request limits", () => {
    expect(() => loadConfig({ BEDROCK_MCP_BEARER_TOKEN: "too-short" })).toThrow();
    expect(() => loadConfig({ BEDROCK_MCP_MAX_REQUEST_BYTES: "100" })).toThrow();
    expect(() => loadConfig({ BEDROCK_MCP_MAX_CONCURRENT_REQUESTS: "0" })).toThrow();
    expect(() => loadConfig({ BEDROCK_MCP_TRUSTED_PROXY_IPS: "127.0.0.1,not-an-ip" })).toThrow();
    expect(() => loadConfig({ BEDROCK_MCP_INCLUDE_PREVIEW: "yes" })).toThrow();
    expect(() => loadConfig({ BEDROCK_MCP_SEMANTIC_ENABLED: "yes" })).toThrow();
    expect(() => loadConfig({ BEDROCK_MCP_SEMANTIC_TOP_K: "101" })).toThrow();
    expect(() => loadConfig({ BEDROCK_MCP_LOCAL_LLM_ENABLED: "yes" })).toThrow();
    expect(() => loadConfig({ BEDROCK_MCP_LOCAL_LLM_BINARY: "" })).toThrow();
    expect(() => loadConfig({ BEDROCK_MCP_LOCAL_LLM_STARTUP_TIMEOUT_MS: "9999" })).toThrow();
    expect(() => loadConfig({ BEDROCK_MCP_LOCAL_LLM_TIMEOUT_MS: "999" })).toThrow();
    expect(() => loadConfig({ BEDROCK_MCP_LOCAL_LLM_MAX_TOKENS: "513" })).toThrow();
    expect(() => loadConfig({ BEDROCK_MCP_LOCAL_LLM_RETRIEVAL_LIMIT: "9" })).toThrow();
    expect(() => loadConfig({ BEDROCK_MCP_LOCAL_LLM_BASE_URL: "https://example.com/v1" })).toThrow();
  });
});
