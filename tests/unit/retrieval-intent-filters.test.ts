import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../../src/db/connection.js";
import { migrateDatabase } from "../../src/db/migrate.js";
import { IndexRepository } from "../../src/db/repository.js";
import { ingestDocument } from "../../src/ingestion/pipeline.js";
import type { SourceDescriptor } from "../../src/models/source.js";
import { searchKnowledge } from "../../src/search/engine.js";
import { detectBedrockQueryIntent } from "../../src/search/intent.js";

const databases: ReturnType<typeof openDatabase>[] = [];

function createDatabase() {
  const database = openDatabase(":memory:");
  databases.push(database);
  migrateDatabase(database);
  const repository = new IndexRepository(database);

  const stableDocs: SourceDescriptor = {
    id: "creator_docs",
    name: "Creator docs",
    tier: 1,
    channel: "stable",
    sourceType: "git",
    revision: "stable-docs",
  };
  const previewDocs: SourceDescriptor = {
    id: "creator_preview",
    name: "Creator preview docs",
    tier: 1,
    channel: "preview",
    sourceType: "git",
    revision: "preview-docs",
  };
  const stableNpm: SourceDescriptor = {
    id: "minecraft_npm_stable",
    name: "Official npm stable",
    tier: 1,
    channel: "stable",
    sourceType: "npm",
    revision: "npm-stable",
  };
  const previewNpm: SourceDescriptor = {
    id: "minecraft_npm_preview",
    name: "Official npm preview",
    tier: 1,
    channel: "preview",
    sourceType: "npm",
    revision: "npm-preview",
  };

  repository.replaceDocument(ingestDocument({
    source: stableDocs,
    path: "creator/ScriptAPI/minecraft/server/System.md",
    content: "# System Class\n## Methods\n### **runInterval**\n`runInterval(callback: () => void): number;`\nStable @minecraft/server reference.",
  }));
  repository.replaceDocument(ingestDocument({
    source: previewDocs,
    path: "creator/ScriptAPI/minecraft/server/SystemPreview.md",
    content: "# System Class\n## Methods\n::: moniker range=\"=minecraft-bedrock-experimental\"\n### **runInterval**\n`runInterval(callback: () => void): number;`\nPreview @minecraft/server reference.\n::: moniker-end",
  }));
  repository.replaceDocument(ingestDocument({
    source: stableNpm,
    path: "metadata/ScriptAPI/minecraft/server/latest.md",
    content: "---\napi_version: \"2.9.0\"\n---\n# @minecraft/server npm latest\nCurrent stable @minecraft/server version is 2.9.0.\n## Manifest dependency\nUse module_name @minecraft/server version 2.9.0 in manifest.json.",
  }));
  repository.replaceDocument(ingestDocument({
    source: previewNpm,
    path: "metadata/ScriptAPI/minecraft/server/beta.md",
    content: "---\napi_version: \"2.11.0-beta.1.26.50-preview.27\"\nminecraft_version: \"1.26.50-preview.27\"\n---\n# @minecraft/server npm beta\nCurrent beta @minecraft/server version is 2.11.0-beta.1.26.50-preview.27.",
  }));

  return database;
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("Bedrock query intent and search filters", () => {
  it("recognizes module, version, manifest, example, and preview intent", () => {
    expect(detectBedrockQueryIntent("current beta @minecraft/server manifest dependency example")).toMatchObject({
      preview: true,
      version: true,
      manifest: true,
      example: true,
      module: "@minecraft/server",
    });
  });

  it("prefers official npm metadata for current beta module-version questions", () => {
    const result = searchKnowledge(createDatabase(), {
      query: "current beta @minecraft/server version",
      limit: 5,
    });
    expect(result.results[0]?.sourceType).toBe("npm");
    expect(result.results[0]?.sourceId).toBe("minecraft_npm_preview");
    expect(result.results[0]?.channel).toBe("preview");
    expect(result.results[0]?.apiPackage).toBe("@minecraft/server");
    expect(result.results[0]?.apiVersion).toBe("2.11.0-beta.1.26.50-preview.27");
  });

  it("prefers stable npm metadata for stable manifest dependency questions", () => {
    const result = searchKnowledge(createDatabase(), {
      query: "stable @minecraft/server manifest dependency version",
      limit: 5,
    });
    expect(result.results[0]?.sourceId).toBe("minecraft_npm_stable");
    expect(result.results[0]?.channel).toBe("stable");
    expect(result.results[0]?.excerpt).toContain("manifest.json");
  });

  it("applies source, channel, module, and path-prefix filters without exposing new tools", () => {
    const database = createDatabase();

    const source = searchKnowledge(database, {
      query: "System.runInterval",
      sourceId: "creator_docs",
      includePreview: true,
      limit: 10,
    });
    expect(source.results.length).toBeGreaterThan(0);
    expect(source.results.every((result) => result.sourceId === "creator_docs")).toBe(true);

    const channel = searchKnowledge(database, {
      query: "System.runInterval",
      channel: "preview",
      limit: 10,
    });
    expect(channel.results.length).toBeGreaterThan(0);
    expect(channel.results.every((result) => result.channel === "preview")).toBe(true);

    const module = searchKnowledge(database, {
      query: "runInterval",
      apiPackage: "@minecraft/server",
      includePreview: true,
      limit: 10,
    });
    expect(module.results.length).toBeGreaterThan(0);
    expect(module.results.every((result) => result.apiPackage === "@minecraft/server")).toBe(true);

    const path = searchKnowledge(database, {
      query: "runInterval",
      pathPrefix: "/creator/ScriptAPI/minecraft/server/",
      includePreview: true,
      limit: 10,
    });
    expect(path.results.length).toBeGreaterThan(0);
    expect(path.results.every((result) => result.path.startsWith("creator/ScriptAPI/minecraft/server/"))).toBe(true);
  });
});
