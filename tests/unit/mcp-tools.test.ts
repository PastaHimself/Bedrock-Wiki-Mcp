import type { McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { registerKnowledgeTools } from "../../src/tools/register.js";

interface RegisteredTool {
  name: string;
  config: unknown;
  handler?: (args: any) => Promise<any>;
}

describe("MCP tool registry", () => {
  it("registers exactly the six intended read-only knowledge tools", async () => {
    const tools: RegisteredTool[] = [];
    const fakeServer = {
      registerTool(name: string, config: unknown, handler?: (args: any) => Promise<any>): void {
        tools.push({ name, config, ...(handler ? { handler } : {}) });
      },
    } as unknown as McpServer;

    registerKnowledgeTools(fakeServer);

    expect(tools.map((tool) => tool.name)).toEqual([
      "search",
      "fetch",
      "get_definition",
      "list_sources",
      "list_categories",
      "plan_lookup",
    ]);

    for (const tool of tools) {
      const config = tool.config as { annotations?: Record<string, unknown> };
      expect(config.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
    }

    const searchConfig = tools.find((tool) => tool.name === "search")?.config as {
      inputSchema: { parse(value: unknown): unknown };
    };
    expect(searchConfig.inputSchema.parse({
      query: "@minecraft/server player input",
      source: "minecraft_creator_docs",
      channel: "preview",
      module: "@minecraft/server",
      pathPrefix: "creator/ScriptAPI/",
    })).toMatchObject({
      source: "minecraft_creator_docs",
      channel: "preview",
      module: "@minecraft/server",
      pathPrefix: "creator/ScriptAPI/",
    });

    const planConfig = tools.find((tool) => tool.name === "plan_lookup")?.config as {
      inputSchema: { parse(value: unknown): unknown };
    };
    expect(planConfig.inputSchema.parse({
      query: "What is world.afterEvents.playerSpawn?",
    })).toMatchObject({
      query: "What is world.afterEvents.playerSpawn?",
    });

    const planned = await tools.find((tool) => tool.name === "plan_lookup")?.handler?.({
      query: "What is world.afterEvents.playerSpawn?",
    });
    expect(planned?.structuredContent).toMatchObject({
      intent: "definition",
      recommendedTool: "get_definition",
      searchQuery: "world.afterEvents.playerSpawn",
    });
  });
});
