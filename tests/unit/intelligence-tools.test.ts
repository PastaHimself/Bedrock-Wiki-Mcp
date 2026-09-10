import { afterEach, describe, expect, it } from "vitest";
import { deriveScriptApiAliases } from "../../src/db/aliases.js";
import { openDatabase } from "../../src/db/connection.js";
import { migrateDatabase } from "../../src/db/migrate.js";
import { IndexRepository } from "../../src/db/repository.js";
import { ingestDocument } from "../../src/ingestion/pipeline.js";
import type { SourceDescriptor } from "../../src/models/source.js";
import { resolveRelationships } from "../../src/search/relationships.js";
import { compareIdentifierVersions } from "../../src/search/version-compare.js";

const databases: ReturnType<typeof openDatabase>[] = [];

function database() {
  const db = openDatabase(":memory:");
  databases.push(db);
  migrateDatabase(db);
  return db;
}

function source(id: string): SourceDescriptor {
  return { id, name: id, tier: 1, channel: "stable", revision: `${id}-sha` };
}

function insertApi(
  repository: IndexRepository,
  sourceDescriptor: SourceDescriptor,
  path: string,
  content: string,
  apiVersion?: string,
): void {
  repository.replaceDocument(ingestDocument({
    source: sourceDescriptor,
    path,
    content,
    ...(apiVersion ? { apiVersion } : {}),
  }));
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe("v1 deterministic intelligence", () => {
  it("traverses derived alias and property-type relationships", () => {
    const db = database();
    const repository = new IndexRepository(db);
    const official = source("official");

    insertApi(
      repository,
      official,
      "creator/ScriptAPI/minecraft/server/World.md",
      "# World Class\n## Properties\n### **afterEvents**\n`read-only afterEvents: WorldAfterEvents;`",
    );
    insertApi(
      repository,
      official,
      "creator/ScriptAPI/minecraft/server/WorldAfterEvents.md",
      "# WorldAfterEvents Class\n## Properties\n### **playerSpawn**\n`read-only playerSpawn: PlayerSpawnAfterEventSignal;`",
    );
    insertApi(
      repository,
      official,
      "creator/ScriptAPI/minecraft/server/PlayerSpawnAfterEventSignal.md",
      "# PlayerSpawnAfterEventSignal Class\n## Methods\n### **subscribe**\n`subscribe(callback: () => void): void;`",
    );

    deriveScriptApiAliases(db);
    const result = resolveRelationships(db, {
      identifier: "world.afterEvents.playerSpawn",
      depth: 2,
      limit: 20,
    });

    expect(result.canonicalIdentifiers).toContain("WorldAfterEvents.playerSpawn");
    expect(result.relationships.some((edge) => edge.relation === "alias_of" && edge.toIdentifier === "WorldAfterEvents.playerSpawn")).toBe(true);
    expect(result.relationships.some((edge) => edge.relation === "property_type" && edge.toIdentifier === "PlayerSpawnAfterEventSignal")).toBe(true);
  });

  it("compares exact API versions without inventing semantic changes", () => {
    const db = database();
    const repository = new IndexRepository(db);

    insertApi(
      repository,
      source("old"),
      "creator/ScriptAPI/minecraft/server/VersionedOld.md",
      "# Versioned Class\n## Methods\n### **doThing**\n`doThing(): void;`\nOld behavior.",
      "1.0.0",
    );
    insertApi(
      repository,
      source("new"),
      "creator/ScriptAPI/minecraft/server/VersionedNew.md",
      "# Versioned Class\n## Methods\n### **doThing**\n`doThing(value: number): void;`\nNew behavior.",
      "2.0.0",
    );

    const result = compareIdentifierVersions(db, {
      identifier: "Versioned.doThing",
      versionKind: "api",
      fromVersion: "1.0.0",
      toVersion: "2.0.0",
    });

    expect(result.status).toBe("changed");
    expect(result.changes.content).toBe(true);
    expect(result.from?.apiVersion).toBe("1.0.0");
    expect(result.to?.apiVersion).toBe("2.0.0");
  });

  it("reports added and removed when only one version has indexed evidence", () => {
    const db = database();
    const repository = new IndexRepository(db);
    insertApi(
      repository,
      source("new"),
      "creator/ScriptAPI/minecraft/server/NewOnly.md",
      "# NewOnly Class\n## Methods\n### **feature**\n`feature(): void;`",
      "2.0.0",
    );

    const added = compareIdentifierVersions(db, {
      identifier: "NewOnly.feature",
      versionKind: "api",
      fromVersion: "1.0.0",
      toVersion: "2.0.0",
    });
    expect(added.status).toBe("added");

    const removed = compareIdentifierVersions(db, {
      identifier: "NewOnly.feature",
      versionKind: "api",
      fromVersion: "2.0.0",
      toVersion: "3.0.0",
    });
    expect(removed.status).toBe("removed");
  });
});
