import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../../src/db/connection.js";
import { migrateDatabase } from "../../src/db/migrate.js";
import { IndexRepository } from "../../src/db/repository.js";
import { ingestDocument } from "../../src/ingestion/pipeline.js";
import type { SourceDescriptor } from "../../src/models/source.js";
import { rebuildSemanticIndex } from "../../src/semantic/builder.js";
import type { TextEmbedder } from "../../src/semantic/embedder.js";

const temporaryDirectories: string[] = [];
const databases: ReturnType<typeof openDatabase>[] = [];

class CountingEmbedder implements TextEmbedder {
  readonly model = "test/counting-8";
  readonly dimensions = 8;
  embeddedTexts = 0;

  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    this.embeddedTexts += texts.length;
    return texts.map((text) => {
      const vector = new Float32Array(this.dimensions);
      vector[text.length % this.dimensions] = 1;
      return vector;
    });
  }
}

const source: SourceDescriptor = {
  id: "official",
  name: "Official",
  tier: 1,
  channel: "stable",
  revision: "sha",
};

function database() {
  const db = openDatabase(":memory:");
  databases.push(db);
  migrateDatabase(db);
  return db;
}

afterEach(async () => {
  for (const db of databases.splice(0)) db.close();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("semantic embedding reuse", () => {
  it("reuses all unchanged vectors on a second build", async () => {
    const core = database();
    const repository = new IndexRepository(core);
    repository.replaceDocument(ingestDocument({
      source,
      path: "docs/a.md",
      content: "# Alpha\nUse minecraft:health for health.",
    }));
    repository.replaceDocument(ingestDocument({
      source,
      path: "docs/b.md",
      content: "# Beta\nUse system.runInterval for repeated work.",
    }));

    const directory = await mkdtemp(join(tmpdir(), "bedrock-semantic-reuse-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "semantic.db");
    const embedder = new CountingEmbedder();

    const first = await rebuildSemanticIndex(core, path, embedder, 2);
    expect(first.chunksEmbedded).toBe(first.chunksTotal);
    expect(first.chunksReused).toBe(0);
    const embeddedAfterFirst = embedder.embeddedTexts;

    const second = await rebuildSemanticIndex(core, path, embedder, 2);
    expect(second.chunksEmbedded).toBe(0);
    expect(second.chunksReused).toBe(second.chunksTotal);
    expect(embedder.embeddedTexts).toBe(embeddedAfterFirst);
  });

  it("embeds only chunks whose content changed", async () => {
    const core = database();
    const repository = new IndexRepository(core);
    repository.replaceDocument(ingestDocument({
      source,
      path: "docs/a.md",
      content: "# Alpha\nFirst version.",
    }));
    repository.replaceDocument(ingestDocument({
      source,
      path: "docs/b.md",
      content: "# Beta\nUnchanged version.",
    }));

    const directory = await mkdtemp(join(tmpdir(), "bedrock-semantic-reuse-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "semantic.db");
    const embedder = new CountingEmbedder();
    await rebuildSemanticIndex(core, path, embedder, 2);

    repository.replaceDocument(ingestDocument({
      source,
      path: "docs/a.md",
      content: "# Alpha\nSecond version changed.",
    }));
    const second = await rebuildSemanticIndex(core, path, embedder, 2);

    expect(second.chunksReused).toBeGreaterThan(0);
    expect(second.chunksEmbedded).toBeGreaterThan(0);
    expect(second.chunksEmbedded).toBeLessThan(second.chunksTotal);
  });
});
