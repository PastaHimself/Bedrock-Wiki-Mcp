import { describe, expect, it } from "vitest";
import { extractBedrockIdentifiers, planBedrockQuery } from "../../src/search/query-helper.js";

describe("Bedrock query helper", () => {
  it("routes exact definition questions without generating an answer", () => {
    const plan = planBedrockQuery("What is world.afterEvents.playerSpawn?");

    expect(plan).toMatchObject({
      intent: "definition",
      recommendedTool: "get_definition",
      searchQuery: "world.afterEvents.playerSpawn",
    });
    expect(plan.identifiers).toContain("world.afterEvents.playerSpawn");
    expect(plan.suggestedKinds).toEqual(["api", "component", "reference"]);
  });

  it("detects Script API modules and preview intent", () => {
    const plan = planBedrockQuery("Show a preview @minecraft/server Player example");

    expect(plan).toMatchObject({
      intent: "example",
      recommendedTool: "search",
      module: "@minecraft/server",
      includePreview: true,
    });
    expect(plan.suggestedKinds).toEqual(["example", "code"]);
  });

  it("routes server-issued ids to fetch", () => {
    expect(planBedrockQuery("fetch chk_abc123 please")).toMatchObject({
      intent: "evidence_fetch",
      recommendedTool: "fetch",
      fetchId: "chk_abc123",
      confidence: 0.99,
    });
  });

  it("routes source and category discovery explicitly", () => {
    expect(planBedrockQuery("which knowledge sources are indexed?").recommendedTool).toBe("list_sources");
    expect(planBedrockQuery("list knowledge categories").recommendedTool).toBe("list_categories");
  });

  it("extracts Bedrock identifiers conservatively", () => {
    expect(extractBedrockIdentifiers(
      "Compare minecraft:health with Player.getComponent and @minecraft/server.Player",
    )).toEqual(expect.arrayContaining([
      "minecraft:health",
      "Player.getComponent",
      "@minecraft/server.Player",
    ]));
  });
});
