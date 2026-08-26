import { describe, expect, it } from "vitest";
import { extractIdentifiers, extractJsonIdentifiers } from "../../src/identifiers/extract.js";
import { identifierSearchTerms, normalizeIdentifier } from "../../src/identifiers/normalize.js";

describe("identifier extraction", () => {
  it("preserves exact Bedrock identifiers and dotted API access", () => {
    const identifiers = extractIdentifiers("Use minecraft:health with world.afterEvents.playerSpawn and system.runInterval.");
    expect(identifiers).toContain("minecraft:health");
    expect(identifiers).toContain("world.afterEvents.playerSpawn");
    expect(identifiers).toContain("system.runInterval");
  });

  it("extracts identifiers from JSON keys", () => {
    expect(extractJsonIdentifiers({ components: { "minecraft:health": { value: 20 } } })).toContain("minecraft:health");
  });

  it("normalizes and decomposes identifiers for later lexical indexing", () => {
    expect(normalizeIdentifier("`System.runInterval`")).toBe("system.runinterval");
    expect(identifierSearchTerms("PlayerBreakBlockAfterEvent")).toContain("Player Break Block After Event");
  });
});
