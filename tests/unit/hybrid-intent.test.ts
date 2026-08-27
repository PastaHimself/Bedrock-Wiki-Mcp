import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../../src/db/connection.js";
import { migrateDatabase } from "../../src/db/migrate.js";
import { IndexRepository } from "../../src/db/repository.js";
import { ingestDocument } from "../../src/ingestion/pipeline.js";
import type { SourceDescriptor } from "../../src/models/source.js";
import { hybridSearchKnowledge } from "../../src/search/hybrid.js";
import type { SemanticRetriever } from "../../src/semantic/retriever.js";

const databases: ReturnType<typeof openDatabase>[] = [];

const stableSource: SourceDescriptor = {
  id: "stable",
  name: "Stable docs",
  tier: 1,
  channel: "stable",
  revision: "stable-sha",
};

const previewSource: SourceDescriptor = {
  id: "preview",
  name: "Preview docs",
  tier: 1,
  channel: "preview",
  revision: "preview-sha",
};

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("hybrid release-channel intent", () => {
  it("infers beta intent for semantic candidates while respecting an explicit preview opt-out", async () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    migrateDatabase(database);
    const repository = new IndexRepository(database);

    repository.replaceDocument(ingestDocument({
      source: stableSource,
      path: "stable.json",
      content: JSON.stringify({
        "minecraft:entity": {
          description: { identifier: "example:stable" },
          components: { "minecraft:health": { value: 20, max: 20 } },
        },
      }),
    }));
    repository.replaceDocument(ingestDocument({
      source: previewSource,
      path: "preview.json",
      content: JSON.stringify({
        "minecraft:entity": {
          description: { identifier: "example:preview" },
          components: { "minecraft:movement": { value: 0.25 } },
        },
      }),
    }));

    const previewChunk = database.prepare(
      "SELECT chunk_id FROM chunks WHERE identifier = 'minecraft:movement'",
    ).get() as { chunk_id: string };
    const semantic: SemanticRetriever = {
      async search() {
        return [{ chunkId: previewChunk.chunk_id, distance: 0.01 }];
      },
    };

    const inferred = await hybridSearchKnowledge(
      database,
      semantic,
      { query: "beta creature locomotion feature" },
      10,
    );
    expect(inferred.results.some((result) => result.identifier === "minecraft:movement")).toBe(true);

    const explicitlyStable = await hybridSearchKnowledge(
      database,
      semantic,
      { query: "beta creature locomotion feature", includePreview: false },
      10,
    );
    expect(explicitlyStable.results.some((result) => result.identifier === "minecraft:movement")).toBe(false);
  });
});
