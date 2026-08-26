import { describe, expect, it } from "vitest";
import { ingestDocument } from "../../src/ingestion/pipeline.js";
import type { SourceDescriptor } from "../../src/models/source.js";

const source: SourceDescriptor = {
  id: "fixture",
  name: "Fixture",
  tier: 1,
  channel: "stable",
};

describe("ingestion pipeline", () => {
  it("classifies and parses Script API documents", () => {
    const document = ingestDocument({
      source,
      path: "creator/ScriptAPI/minecraft/server/System.md",
      content: "# System Class\n## Methods\n### **runInterval**\n`runInterval(callback: () => void, tickInterval?: number): number;`",
    });
    expect(document.metadata.kind).toBe("api");
    expect(document.metadata.apiPackage).toBe("@minecraft/server");
    expect(document.identifiers).toContain("System.runInterval");
  });

  it("marks PriorScriptAPI documents historical", () => {
    const document = ingestDocument({
      source,
      path: "creator/PriorScriptAPI/minecraft/server-1xx/World.md",
      content: "# World Class\nOld API",
    });
    expect(document.metadata.lifecycle).toBe("historical");
    expect(document.chunks[0]?.lifecycle).toBe("historical");
  });
});
