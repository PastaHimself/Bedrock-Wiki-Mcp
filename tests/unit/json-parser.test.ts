import { describe, expect, it } from "vitest";
import { parseBedrockJson } from "../../src/parsers/json.js";

describe("Bedrock JSON parser", () => {
  it("chunks entity components with entity context", () => {
    const parsed = parseBedrockJson(JSON.stringify({
      "minecraft:entity": {
        description: { identifier: "example:mob" },
        components: {
          "minecraft:health": { value: 20, max: 20 },
          "minecraft:movement": { value: 0.2 },
        },
      },
    }), "behavior_pack/entities/mob.json");

    const health = parsed.chunks.find((chunk) => chunk.identifier === "minecraft:health");
    expect(health?.jsonPointer).toBe("/minecraft:entity/components/minecraft:health");
    expect(health?.content).toContain("example:mob");
    expect(health?.content).toContain("minecraft:health");
  });

  it("chunks animation controllers independently", () => {
    const parsed = parseBedrockJson(JSON.stringify({ animation_controllers: {
      "controller.animation.example": { initial_state: "default", states: { default: {} } },
    } }), "resource_pack/animation_controllers/example.json");
    expect(parsed.chunks[0]?.identifier).toBe("controller.animation.example");
    expect(parsed.chunks[0]?.symbolKind).toBe("animation-controller");
  });
});
