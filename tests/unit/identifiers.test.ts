import { describe, expect, it } from "vitest";
import { extractCodeIdentifiers, extractIdentifiers, extractJsonIdentifiers } from "../../src/identifiers/extract.js";
import { identifierSearchTerms, normalizeIdentifier } from "../../src/identifiers/normalize.js";

describe("identifier extraction", () => {
  it("preserves exact Bedrock identifiers and dotted API access", () => {
    const identifiers = extractIdentifiers("Use minecraft:health with world.afterEvents.playerSpawn and system.runInterval.");
    expect(identifiers).toContain("minecraft:health");
    expect(identifiers).toContain("world.afterEvents.playerSpawn");
    expect(identifiers).toContain("playerSpawn");
    expect(identifiers).toContain("system.runInterval");
  });

  it("captures distinctive API type names without treating generic prose as identifiers", () => {
    const identifiers = extractIdentifiers("Use This Documentation with PlayerBreakBlockAfterEvent and `World`.");
    expect(identifiers).toContain("PlayerBreakBlockAfterEvent");
    expect(identifiers).toContain("World");
    expect(identifiers).not.toContain("Use");
    expect(identifiers).not.toContain("This");
    expect(identifiers).not.toContain("Documentation");
  });

  it("captures Molang queries and slash commands", () => {
    const identifiers = extractIdentifiers("Use query.is_on_ground and run `/scoreboard players list`. Then /execute as @s run say hi.");
    expect(identifiers).toContain("query.is_on_ground");
    expect(identifiers).toContain("is_on_ground");
    expect(identifiers).toContain("/scoreboard");
    expect(identifiers).toContain("/execute");
  });

  it("qualifies imported Script API symbols with their official module", () => {
    const identifiers = extractCodeIdentifiers(`import { world, type Player as ServerPlayer } from "@minecraft/server";\nworld.afterEvents.playerSpawn.subscribe(() => {});`);
    expect(identifiers).toContain("@minecraft/server");
    expect(identifiers).toContain("@minecraft/server.world");
    expect(identifiers).toContain("@minecraft/server.Player");
    expect(identifiers).toContain("ServerPlayer");
    expect(identifiers).toContain("world.afterEvents.playerSpawn");
  });

  it("extracts Bedrock JSON components, manifest fields, format versions, states, and schema properties", () => {
    const identifiers = extractJsonIdentifiers({
      format_version: "1.21.0",
      header: { min_engine_version: [1, 21, 0] },
      components: { "minecraft:health": { value: 20 } },
      animation_controllers: {
        "controller.animation.test": { states: { default: { transitions: [] } } },
      },
      properties: { custom_field: { type: "string" } },
    });
    expect(identifiers).toContain("minecraft:health");
    expect(identifiers).toContain("format_version:1.21.0");
    expect(identifiers).toContain("manifest.min_engine_version");
    expect(identifiers).toContain("animation_controller.state.default");
    expect(identifiers).toContain("schema.custom_field");
  });

  it("normalizes and decomposes identifiers for later lexical indexing", () => {
    expect(normalizeIdentifier("`System.runInterval`")).toBe("system.runinterval");
    expect(identifierSearchTerms("PlayerBreakBlockAfterEvent")).toContain("Player Break Block After Event");
  });
});
