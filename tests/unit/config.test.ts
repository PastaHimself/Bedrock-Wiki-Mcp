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
    });
  });

  it("parses deployment overrides", () => {
    const config = loadConfig(
      {
        NODE_ENV: "production",
        BEDROCK_MCP_HOST: "0.0.0.0",
        BEDROCK_MCP_PORT: "3000",
        BEDROCK_MCP_DATA_DIR: "/home/container/data",
        BEDROCK_MCP_LOG_LEVEL: "warn",
      },
      "/ignored",
    );

    expect(config).toEqual({
      nodeEnv: "production",
      host: "0.0.0.0",
      port: 3000,
      dataDir: "/home/container/data",
      logLevel: "warn",
    });
  });

  it.each(["0", "65536", "not-a-port"])("rejects invalid port %s", (port) => {
    expect(() => loadConfig({ BEDROCK_MCP_PORT: port })).toThrow();
  });
});
