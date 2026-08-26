import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../../src/config.js";
import { close, createHttpServer, listen } from "../../src/server.js";

const openServers: ReturnType<typeof createHttpServer>[] = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => close(server)));
});

describe("HTTP server", () => {
  it("serves a minimal health response", async () => {
    const config: AppConfig = {
      nodeEnv: "test",
      host: "127.0.0.1",
      port: 0,
      dataDir: "/tmp/bedrock-mcp-test",
      logLevel: "error",
    };
    const server = createHttpServer(config);
    openServers.push(server);
    await listen(server, config);

    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/health`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "ok",
      service: "bedrock-wiki-mcp",
      version: "0.1.0",
    });
  });
});
