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

  it("accepts Bedrock JSONC comments and trailing commas without changing string contents", () => {
    const parsed = parseBedrockJson(`{
      "minecraft:entity": {
        "description": {
          "identifier": "minecraft:axolotl",
          "documentation_url": "https://example.com/path//literal/*text*/"
        },
        "components": {
          "minecraft:breedable": {
            "mutation_factor": {
              "variant": 0.00083 // roughly 1/1200
            },
          },
        }
      }
    }`, "creator/Reference/Source/VanillaBehaviorPack/entities/axolotl.json");

    expect(parsed.identifiers).toContain("minecraft:axolotl");
    const breedable = parsed.chunks.find((chunk) => chunk.identifier === "minecraft:breedable");
    expect(breedable?.content).toContain("0.00083");
    expect(parsed.chunks[0]?.content).toContain("https://example.com/path//literal/*text*/");
  });

  it("accepts block comments used in relaxed Bedrock JSON", () => {
    const parsed = parseBedrockJson(`{
      /* behavior-pack entity metadata */
      "minecraft:entity": {
        "description": { "identifier": "example:commented" },
        "components": { "minecraft:health": { "value": 20 } }
      }
    }`, "behavior_pack/entities/commented.json");

    expect(parsed.identifiers).toContain("example:commented");
    expect(parsed.chunks.some((chunk) => chunk.identifier === "minecraft:health")).toBe(true);
  });

  it("accepts UTF-8 BOM used by Mojang Bedrock sample JSON", () => {
    const parsed = parseBedrockJson(`\uFEFF{
      "format_version": "1.21.30",
      "minecraft:texture_set": {
        "color": "acacia_trapdoor",
        "metalness_emissive_roughness_subsurface": "acacia_trapdoor_mers"
      }
    }`, "resource_pack/textures/blocks/acacia_trapdoor.texture_set.json");

    expect(parsed.title).toBe("acacia_trapdoor.texture_set.json");
    expect(parsed.chunks[0]?.content).toContain("acacia_trapdoor_mers");
  });

  it("still rejects genuinely malformed JSON after JSONC normalization", () => {
    expect(() => parseBedrockJson(
      `{"minecraft:entity":{"description":{"identifier":"example:broken"} "components":{}}}`,
      "behavior_pack/entities/broken.json",
    )).toThrow("Invalid JSON in behavior_pack/entities/broken.json");
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
