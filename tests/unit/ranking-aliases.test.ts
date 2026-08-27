import { afterEach, describe, expect, it } from "vitest";
import { deriveScriptApiAliases } from "../../src/db/aliases.js";
import { openDatabase } from "../../src/db/connection.js";
import { migrateDatabase } from "../../src/db/migrate.js";
import { IndexRepository } from "../../src/db/repository.js";
import { ingestDocument } from "../../src/ingestion/pipeline.js";
import type { SourceDescriptor } from "../../src/models/source.js";
import { getDefinition } from "../../src/search/definition.js";
import { searchKnowledge } from "../../src/search/engine.js";
import { versionCompatibility } from "../../src/search/version.js";

const databases: ReturnType<typeof openDatabase>[] = [];

function source(id: string, channel: "stable" | "preview" = "stable"): SourceDescriptor {
  return {
    id,
    name: id,
    tier: 1,
    channel,
    revision: `${id}-sha`,
  };
}

function database() {
  const db = openDatabase(":memory:");
  databases.push(db);
  migrateDatabase(db);
  return db;
}

function insertScriptApi(
  repository: IndexRepository,
  sourceDescriptor: SourceDescriptor,
  path: string,
  content: string,
  versions: { minecraftVersion?: string; apiVersion?: string } = {},
): void {
  repository.replaceDocument(ingestDocument({
    source: sourceDescriptor,
    path,
    content,
    ...(versions.minecraftVersion !== undefined ? { minecraftVersion: versions.minecraftVersion } : {}),
    ...(versions.apiVersion !== undefined ? { apiVersion: versions.apiVersion } : {}),
  }));
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe("Script API alias ranking", () => {
  it("derives runtime property chains while returning canonical documented members", () => {
    const db = database();
    const repository = new IndexRepository(db);
    const official = source("official");

    insertScriptApi(
      repository,
      official,
      "creator/ScriptAPI/minecraft/server/World.md",
      "# World Class\n## Properties\n### **afterEvents**\n`read-only afterEvents: WorldAfterEvents;`\nType: [*WorldAfterEvents*](WorldAfterEvents.md)",
    );
    insertScriptApi(
      repository,
      official,
      "creator/ScriptAPI/minecraft/server/WorldAfterEvents.md",
      "# WorldAfterEvents Class\n## Properties\n### **playerSpawn**\n`read-only playerSpawn: PlayerSpawnAfterEventSignal;`\nType: [*PlayerSpawnAfterEventSignal*](PlayerSpawnAfterEventSignal.md)",
    );
    insertScriptApi(
      repository,
      official,
      "creator/ScriptAPI/minecraft/server/PlayerSpawnAfterEventSignal.md",
      "# PlayerSpawnAfterEventSignal Class\n## Methods\n### **subscribe**\n`subscribe(callback: (arg: PlayerSpawnAfterEvent) => void): (arg: PlayerSpawnAfterEvent) => void;`\nRegisters a callback.",
    );

    const report = deriveScriptApiAliases(db);
    expect(report.propertyTypeEdges).toBeGreaterThanOrEqual(2);
    expect(report.aliasesInserted).toBeGreaterThanOrEqual(2);

    const event = searchKnowledge(db, { query: "world.afterEvents.playerSpawn" });
    expect(event.results[0]?.exactMatch).toBe(true);
    expect(event.results[0]?.identifier).toBe("WorldAfterEvents.playerSpawn");

    const subscribe = searchKnowledge(db, { query: "world.afterEvents.playerSpawn.subscribe" });
    expect(subscribe.results[0]?.exactMatch).toBe(true);
    expect(subscribe.results[0]?.identifier).toBe("PlayerSpawnAfterEventSignal.subscribe");

    const definition = getDefinition(db, { identifier: "world.afterEvents.playerSpawn.subscribe" });
    expect(definition.stableDefinitionFound).toBe(true);
    expect(definition.definitions[0]?.identifier).toBe("PlayerSpawnAfterEventSignal.subscribe");
  });

  it("keeps derived aliases idempotent across repeated derivation passes", () => {
    const db = database();
    const repository = new IndexRepository(db);
    const official = source("official");

    insertScriptApi(repository, official, "creator/ScriptAPI/minecraft/server/World.md", "# World Class\n## Properties\n### **afterEvents**\n`read-only afterEvents: WorldAfterEvents;`");
    insertScriptApi(repository, official, "creator/ScriptAPI/minecraft/server/WorldAfterEvents.md", "# WorldAfterEvents Class\n## Methods\n### **testEvent**\n`testEvent(): void;`");

    const first = deriveScriptApiAliases(db);
    const second = deriveScriptApiAliases(db);
    expect(first.aliasesInserted).toBeGreaterThanOrEqual(1);
    expect(second.aliasesInserted).toBe(0);

    const count = db.prepare("SELECT count(*) AS count FROM identifiers WHERE alias_type = 'derived-chain'").get() as { count: number };
    expect(count.count).toBe(first.aliasesInserted);
  });
});

describe("version-aware ranking", () => {
  it("prefers exact version provenance and rejects known mismatches", () => {
    const db = database();
    const repository = new IndexRepository(db);

    insertScriptApi(
      repository,
      source("current"),
      "creator/ScriptAPI/minecraft/server/VersionedCurrent.md",
      "# Versioned Class\n## Methods\n### **doThing**\n`doThing(): void;`\nCurrent version.",
      { minecraftVersion: "1.21.80", apiVersion: "2.0.0" },
    );
    insertScriptApi(
      repository,
      source("old"),
      "creator/ScriptAPI/minecraft/server/VersionedOld.md",
      "# Versioned Class\n## Methods\n### **doThing**\n`doThing(): void;`\nOlder version.",
      { minecraftVersion: "1.21.70", apiVersion: "1.9.0" },
    );
    insertScriptApi(
      repository,
      source("unknown"),
      "creator/ScriptAPI/minecraft/server/VersionedUnknown.md",
      "# Versioned Class\n## Methods\n### **doThing**\n`doThing(): void;`\nUnversioned fallback.",
    );

    const result = searchKnowledge(db, {
      query: "Versioned.doThing",
      minecraftVersion: "1.21.80",
      apiVersion: "2.0.0",
      limit: 10,
    });
    expect(result.results[0]?.sourceId).toBe("current");
    expect(result.results.some((hit) => hit.sourceId === "old")).toBe(false);
    expect(result.results.some((hit) => hit.sourceId === "unknown")).toBe(true);

    const definition = getDefinition(db, {
      identifier: "Versioned.doThing",
      minecraftVersion: "1.21.80",
      apiVersion: "2.0.0",
    });
    expect(definition.definitions[0]?.sourceId).toBe("current");
    expect(definition.definitions.some((hit) => hit.sourceId === "old")).toBe(false);
  });

  it("supports numeric version prefixes while keeping different major versions incompatible", () => {
    expect(versionCompatibility("1.21", "1.21.80")).toBe("compatible");
    expect(versionCompatibility("v2", "2.9.0")).toBe("compatible");
    expect(versionCompatibility("2.9.0", "2.9.0")).toBe("exact");
    expect(versionCompatibility("2", "1.9.0")).toBe("mismatch");
    expect(versionCompatibility("1.21.80", undefined)).toBe("unknown");
  });
});
