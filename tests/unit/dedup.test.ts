import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../../src/db/connection.js";
import { migrateDatabase } from "../../src/db/migrate.js";
import { IndexRepository } from "../../src/db/repository.js";
import { ingestDocument } from "../../src/ingestion/pipeline.js";
import type { SourceDescriptor } from "../../src/models/source.js";
import { evidenceSimilarity, isNearDuplicateEvidence } from "../../src/search/dedup.js";
import { searchKnowledge } from "../../src/search/engine.js";

const databases: ReturnType<typeof openDatabase>[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("cross-source evidence deduplication", () => {
  it("detects formatting-only and near-identical copies but preserves channel/version distinctions", () => {
    const first = { text: "# Player spawn\nUse world.afterEvents.playerSpawn to observe a player joining the world.", channel: "stable", apiVersion: "2.0.0" };
    const copy = { text: "Player spawn — use `world.afterEvents.playerSpawn` to observe a player joining the world.", channel: "stable", apiVersion: "2.0.0" };
    expect(evidenceSimilarity(first, copy)).toBeGreaterThan(0.5);
    expect(isNearDuplicateEvidence({ ...first, text: `${first.text}\nThis sentence makes the source materially longer with another distinct explanation.` }, { ...copy, text: `${copy.text}\nThis sentence makes the source materially longer with another distinct explanation.` }, 0.5)).toBe(true);
    expect(isNearDuplicateEvidence(first, { ...first, channel: "preview" })).toBe(false);
    expect(isNearDuplicateEvidence(first, { ...first, apiVersion: "3.0.0" })).toBe(false);
  });

  it("returns one copy of duplicated evidence and keeps the higher-trust source", () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    migrateDatabase(database);
    const repository = new IndexRepository(database);
    const official: SourceDescriptor = { id: "official", name: "Official docs", tier: 1, channel: "stable", revision: "a" };
    const community: SourceDescriptor = { id: "community", name: "Community docs", tier: 3, channel: "stable", revision: "b" };
    const content = "# Spawn event\nUse world.afterEvents.playerSpawn to run code after a player spawns. This example shows how to subscribe and handle the event safely in a behavior pack.";

    repository.replaceDocument(ingestDocument({ source: community, path: "guides/spawn.md", content }));
    repository.replaceDocument(ingestDocument({ source: official, path: "creator/ScriptAPI/spawn.md", content }));

    const result = searchKnowledge(database, { query: "world.afterEvents.playerSpawn", limit: 10 });
    const matching = result.results.filter((item) => item.excerpt.includes("run code after a player spawns"));
    expect(matching).toHaveLength(1);
    expect(matching[0]?.sourceId).toBe("official");
  });
});
