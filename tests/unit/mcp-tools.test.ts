import type { McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { registerKnowledgeTools } from "../../src/tools/register.js";

interface RegisteredTool {
  name: string;
  config: unknown;
  handler?: (args: unknown) => Promise<unknown>;
}

describe("MCP tool registry", () => {
  it("registers exactly the six intended read-only knowledge tools", async () => {
    const tools: RegisteredTool[] = [];
    const fakeServer = {
      registerTool(name: string, config: unknown, handler?: (args: unknown) => Promise<unknown>): void {
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
      "ask_bedrock",
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

    const askConfig = tools.find((tool) => tool.name === "ask_bedrock")?.config as {
      inputSchema: { parse(value: unknown): unknown };
    };
    expect(askConfig.inputSchema.parse({
      query: "How do I listen for player input?",
      channel: "stable",
      module: "@minecraft/server",
      limit: 4,
    })).toMatchObject({
      query: "How do I listen for player input?",
      channel: "stable",
      module: "@minecraft/server",
      limit: 4,
    });

    const disabled = await tools.find((tool) => tool.name === "ask_bedrock")?.handler?.({
      query: "How do I listen for player input?",
    });
    expect(disabled).toMatchObject({ isError: true });
    expect((disabled as { content: Array<{ text: string }> }).content[0]?.text)
      .toContain("LOCAL_LLM_DISABLED");
  });
});
