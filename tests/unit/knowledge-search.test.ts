import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../../src/db/connection.js";
import { migrateDatabase } from "../../src/db/migrate.js";
import { IndexRepository } from "../../src/db/repository.js";
import { ingestDocument } from "../../src/ingestion/pipeline.js";
import type { SourceDescriptor } from "../../src/models/source.js";
import { getDefinition } from "../../src/search/definition.js";
import { listKnowledgeCategories, listKnowledgeSources } from "../../src/search/discovery.js";
import { searchKnowledge } from "../../src/search/engine.js";
import { fetchKnowledge } from "../../src/search/fetch.js";

const databases: ReturnType<typeof openDatabase>[] = [];

const official: SourceDescriptor = {
  id: "official",
  name: "Official docs",
  tier: 1,
  channel: "stable",
  revision: "stable-sha",
  repository: "https://github.com/MicrosoftDocs/minecraft-creator.git",
};

const preview: SourceDescriptor = {
  id: "preview",
  name: "Preview docs",
  tier: 1,
  channel: "preview",
  revision: "preview-sha",
};

function database() {
  const db = openDatabase(":memory:");
  databases.push(db);
  migrateDatabase(db);
  const repository = new IndexRepository(db);
  repository.replaceDocument(ingestDocument({
    source: official,
    path: "creator/ScriptAPI/minecraft/server/System.md",
    canonicalUrl: "https://learn.microsoft.com/minecraft/creator/scriptapi/minecraft/server/system",
    content: "# System Class\n## Methods\n### **runInterval**\n`runInterval(callback: () => void): number;`\nSchedules repeating work.",
  }));
  repository.replaceDocument(ingestDocument({
    source: official,
    path: "behavior_pack/entities/example.json",
    content: JSON.stringify({
      "minecraft:entity": {
        description: { identifier: "example:mob" },
        components: {
          "minecraft:health": { value: 20, max: 20 },
          "minecraft:movement": { value: 0.2 },
        },
      },
    }),
  }));
  repository.replaceDocument(ingestDocument({
    source: preview,
    path: "creator/ScriptAPI/minecraft/server/SystemPreview.md",
    content: "# System Class\n## Methods\n::: moniker range=\"=minecraft-bedrock-experimental\"\n### **runInterval**\n`runInterval(callback: () => void): number;`\nPreview behavior.\n::: moniker-end",
  }));
  return db;
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe("knowledge retrieval", () => {
  it("gives exact identifiers dominant relevance and hides preview by default", () => {
    const result = searchKnowledge(database(), { query: "System.runInterval" });
    expect(result.results[0]?.identifier).toBe("System.runInterval");
    expect(result.results[0]?.exactMatch).toBe(true);
    expect(result.results[0]?.channel).toBe("stable");
    expect(result.results.some((hit) => hit.channel === "preview")).toBe(false);
  });

  it("retrieves natural-language evidence with bounded excerpts", () => {
    const result = searchKnowledge(database(), { query: "health", maxChars: 2000 });
    expect(result.results[0]?.identifier).toBe("minecraft:health");
    expect(result.totalChars).toBeLessThanOrEqual(2000);
    expect(result.results[0]?.excerpt).toContain("minecraft:health");
  });

  it("allows preview results only when explicitly requested", () => {
    const result = searchKnowledge(database(), { query: "System.runInterval", includePreview: true, limit: 10 });
    expect(result.results.some((hit) => hit.channel === "preview")).toBe(true);
  });

  it("fetches only controlled IDs and includes bounded adjacent chunk context", () => {
    const db = database();
    const result = searchKnowledge(db, { query: "minecraft:health" });
    const health = result.results.find((hit) => hit.identifier === "minecraft:health");
    expect(health).toBeDefined();

    const fetched = fetchKnowledge(db, { id: health?.chunkId ?? "", contextBefore: 0, contextAfter: 1, maxChars: 4000 });
    expect(fetched.targetKind).toBe("chunk");
    expect(fetched.requestedChunkId).toBe(health?.chunkId);
    expect(fetched.chunks.length).toBeGreaterThanOrEqual(1);
    expect(fetched.totalChars).toBeLessThanOrEqual(4000);
    expect(() => fetchKnowledge(db, { id: "/etc/passwd" })).toThrow("INVALID_DOCUMENT_ID");
  });

  it("returns stable definitions and explicitly falls back to preview when stable is absent", () => {
    const db = database();
    const stable = getDefinition(db, { identifier: "System.runInterval" });
    expect(stable.stableDefinitionFound).toBe(true);
    expect(stable.definitions[0]?.channel).toBe("stable");

    const repository = new IndexRepository(db);
    repository.replaceDocument(ingestDocument({
      source: preview,
      path: "creator/ScriptAPI/minecraft/server/PreviewOnly.md",
      content: "# PreviewOnly Class\n## Methods\n::: moniker range=\"=minecraft-bedrock-experimental\"\n### **newThing**\n`newThing(): void;`\n::: moniker-end",
    }));
    const fallback = getDefinition(db, { identifier: "PreviewOnly.newThing" });
    expect(fallback.stableDefinitionFound).toBe(false);
    expect(fallback.definitions[0]?.channel).toBe("preview");
    expect(fallback.warning).toContain("No current stable definition");
  });

  it("lists indexed sources and categories with counts", () => {
    const db = database();
    const sources = listKnowledgeSources(db);
    expect(sources.find((source) => source.id === "official")?.tier).toBe(1);
    expect(sources.find((source) => source.id === "official")?.documents).toBe(2);

    const categories = listKnowledgeCategories(db);
    expect(categories.some((category) => category.id === "script_api")).toBe(true);
    expect(categories.some((category) => category.id === "entities")).toBe(true);
  });
});
