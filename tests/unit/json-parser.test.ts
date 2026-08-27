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

  it("uses custom entity event keys as primary chunk identifiers", () => {
    const parsed = parseBedrockJson(JSON.stringify({
      "minecraft:entity": {
        description: { identifier: "example:mob" },
        events: { on_spawn: { add: { component_groups: ["ready"] } } },
      },
    }), "behavior_pack/entities/mob.json");
    const event = parsed.chunks.find((chunk) => chunk.symbolKind === "event");
    expect(event?.identifier).toBe("on_spawn");
    expect(event?.identifiers).toContain("example:mob");
  });

  it("chunks animation controllers independently", () => {
    const parsed = parseBedrockJson(JSON.stringify({ animation_controllers: {
      "controller.animation.example": { initial_state: "default", states: { default: {} } },
    } }), "resource_pack/animation_controllers/example.json");
    expect(parsed.chunks[0]?.identifier).toBe("controller.animation.example");
    expect(parsed.chunks[0]?.symbolKind).toBe("animation-controller");
  });

  it("chunks Bedrock JSON Schema properties into exact definitions", () => {
    const parsed = parseBedrockJson(JSON.stringify({
      $schema: "http://json-schema.org/draft-07/schema#",
      title: "Block Components",
      description: "Container for custom block components.",
      properties: {
        "minecraft:collision_box": {
          title: "Minecraft Collision Box",
          description: "Defines the collision box for this block.",
          type: "object",
        },
        "minecraft:breathability": {
          description: "Deprecated breathability component.",
          deprecated: true,
          type: "object",
        },
      },
    }), "schemas/bp/blocks/block_components.schema.json");

    const collision = parsed.chunks.find((chunk) => chunk.identifier === "minecraft:collision_box");
    expect(collision?.symbolKind).toBe("property");
    expect(collision?.jsonPointer).toBe("/properties/minecraft:collision_box");
    expect(collision?.content).toContain("Defines the collision box");

    const deprecated = parsed.chunks.find((chunk) => chunk.identifier === "minecraft:breathability");
    expect(deprecated?.lifecycle).toBe("deprecated");
  });

  it("extracts protocol version context and scoped packet properties", () => {
    const parsed = parseBedrockJson(JSON.stringify({
      title: "ActorEventPacket",
      $schema: "http://json-schema.org/draft-07/schema#",
      "x-minecraft-version": "1.26.50-beta.26",
      "x-protocol-version": 2192,
      properties: {
        eventId: {
          description: "Actor event identifier.",
          type: "integer",
        },
      },
    }), "json/ActorEventPacket.json");

    expect(parsed.minecraftVersion).toBe("1.26.50-beta.26");
    expect(parsed.chunks[0]?.identifier).toBe("ActorEventPacket");
    const eventId = parsed.chunks.find((chunk) => chunk.identifier === "ActorEventPacket.eventId");
    expect(eventId?.symbolKind).toBe("property");
    expect(eventId?.content).toContain("Actor event identifier");
  });
});
