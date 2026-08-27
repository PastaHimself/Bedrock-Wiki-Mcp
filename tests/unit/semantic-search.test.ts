import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../../src/db/connection.js";
import { migrateDatabase } from "../../src/db/migrate.js";
import { IndexRepository } from "../../src/db/repository.js";
import { ingestDocument } from "../../src/ingestion/pipeline.js";
import type { SourceDescriptor } from "../../src/models/source.js";
import { hybridSearchKnowledge } from "../../src/search/hybrid.js";
import { rebuildSemanticIndex } from "../../src/semantic/builder.js";
import { coreSemanticFingerprint } from "../../src/semantic/database.js";
import type { TextEmbedder } from "../../src/semantic/embedder.js";
import { openSemanticRetriever, type SemanticRetriever } from "../../src/semantic/retriever.js";

const temporaryDirectories: string[] = [];
const databases: ReturnType<typeof openDatabase>[] = [];

const source: SourceDescriptor = {
  id: "official",
  name: "Official docs",
  tier: 1,
  channel: "stable",
  revision: "abc123",
};

class FakeEmbedder implements TextEmbedder {
  readonly model = "test/fake-384";
  readonly dimensions = 384;

  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    return texts.map((text) => {
      const vector = new Float32Array(this.dimensions);
      const normalized = text.toLowerCase();
      if (normalized.includes("chase") || normalized.includes("nearest_attackable_target") || normalized.includes("hostile target")) {
        vector[0] = 1;
      } else if (normalized.includes("health") || normalized.includes("survive")) {
        vector[1] = 1;
      } else {
        vector[2] = 1;
      }
      return vector;
    });
  }
}

function coreDatabase() {
  const database = openDatabase(":memory:");
  databases.push(database);
  migrateDatabase(database);
  const repository = new IndexRepository(database);
  repository.replaceDocument(ingestDocument({
    source,
    path: "behavior_pack/entities/targeting.json",
    content: JSON.stringify({
      "minecraft:entity": {
        description: { identifier: "example:hunter" },
        components: {
          "minecraft:behavior.nearest_attackable_target": { priority: 1 },
        },
      },
    }),
  }));
  repository.replaceDocument(ingestDocument({
    source,
    path: "behavior_pack/entities/health.json",
    content: JSON.stringify({
      "minecraft:entity": {
        description: { identifier: "example:tank" },
        components: { "minecraft:health": { value: 40, max: 40 } },
      },
    }),
  }));
  return database;
}

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("semantic index", () => {
  it("builds sqlite-vec atomically and retrieves nearest chunks", async () => {
    const core = coreDatabase();
    const directory = await mkdtemp(join(tmpdir(), "bedrock-semantic-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "semantic.db");
    const embedder = new FakeEmbedder();

    const build = await rebuildSemanticIndex(core, path, embedder, 2);
    expect(build.chunksEmbedded).toBeGreaterThanOrEqual(2);

    const retriever = openSemanticRetriever(path, embedder, coreSemanticFingerprint(core), 10);
    try {
      const hits = await retriever.search("make the creature chase hostile targets", 5);
      const first = hits[0];
      expect(first).toBeDefined();
      const top = core.prepare("SELECT identifier FROM chunks WHERE chunk_id = ?").get(first!.chunkId) as { identifier: string | null } | undefined;
      expect(top?.identifier).toBe("minecraft:behavior.nearest_attackable_target");
    } finally {
      retriever.close();
    }
  });

  it("rejects a semantic database built for a different core index", async () => {
    const core = coreDatabase();
    const directory = await mkdtemp(join(tmpdir(), "bedrock-semantic-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "semantic.db");
    const embedder = new FakeEmbedder();
    await rebuildSemanticIndex(core, path, embedder);
    expect(() => openSemanticRetriever(path, embedder, "sha256:stale", 10)).toThrow("SEMANTIC_INDEX_STALE");
  });
});

describe("hybrid retrieval", () => {
  it("adds semantic-only evidence for conceptual natural-language queries", async () => {
    const core = coreDatabase();
    const target = core.prepare("SELECT chunk_id FROM chunks WHERE identifier = 'minecraft:health'").get() as { chunk_id: string };
    const semantic: SemanticRetriever = {
      async search() {
        return [{ chunkId: target.chunk_id, distance: 0.05 }];
      },
    };
    const result = await hybridSearchKnowledge(core, semantic, { query: "help this creature survive longer" }, 10);
    expect(result.results.some((entry) => entry.identifier === "minecraft:health")).toBe(true);
  });

  it("never lets semantic similarity outrank an exact identifier hit", async () => {
    const core = coreDatabase();
    const health = core.prepare("SELECT chunk_id FROM chunks WHERE identifier = 'minecraft:health'").get() as { chunk_id: string };
    const semantic: SemanticRetriever = {
      async search() {
        return [{ chunkId: health.chunk_id, distance: 0 }];
      },
    };
    const result = await hybridSearchKnowledge(core, semantic, { query: "minecraft:behavior.nearest_attackable_target" }, 10);
    expect(result.results[0]?.identifier).toBe("minecraft:behavior.nearest_attackable_target");
    expect(result.results[0]?.exactMatch).toBe(true);
  });
});