import { randomUUID } from "node:crypto";
import { rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { MAX_EMBED_TEXT_CHARS } from "./constants.js";
import { coreSemanticFingerprint, float32Blob, initializeSemanticSchema, openSemanticDatabase } from "./database.js";
import type { TextEmbedder } from "./embedder.js";

interface CoreChunkRow {
  id: number;
  chunk_id: string;
  content_hash: string;
  title: string;
  identifier: string | null;
  content: string;
  path: string;
}

export interface SemanticBuildResult {
  targetPath: string;
  model: string;
  dimensions: number;
  chunksEmbedded: number;
  coreFingerprint: string;
}

function embeddingText(row: CoreChunkRow): string {
  const parts = [row.title, row.identifier ?? "", row.path, row.content].filter(Boolean);
  return parts.join("\n").slice(0, MAX_EMBED_TEXT_CHARS);
}

async function cleanup(path: string): Promise<void> {
  await Promise.all([
    rm(path, { force: true }),
    rm(`${path}-wal`, { force: true }),
    rm(`${path}-shm`, { force: true }),
  ]);
}

export async function rebuildSemanticIndex(
  coreDatabase: DatabaseSync,
  targetPath: string,
  embedder: TextEmbedder,
  batchSize = 32,
): Promise<SemanticBuildResult> {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 256) {
    throw new RangeError("semantic batchSize must be an integer between 1 and 256");
  }
  const coreFingerprint = coreSemanticFingerprint(coreDatabase);
  const buildPath = join(dirname(targetPath), `.semantic-${randomUUID()}.building.db`);
  const semantic = openSemanticDatabase(buildPath);
  let chunksEmbedded = 0;

  try {
    initializeSemanticSchema(semantic, embedder.dimensions, embedder.model, coreFingerprint);
    const insertChunk = semantic.prepare(
      "INSERT INTO semantic_chunks(rowid, chunk_id, content_hash) VALUES (?, ?, ?)",
    );
    const insertVector = semantic.prepare(
      "INSERT INTO chunk_vectors(rowid, embedding) VALUES (?, ?)",
    );
    const rows = coreDatabase.prepare(`
      SELECT c.id, c.chunk_id, c.content_hash, c.title, c.identifier, c.content, d.path
      FROM chunks c
      JOIN documents d ON d.id = c.document_id
      ORDER BY c.id
    `).iterate() as Iterable<CoreChunkRow>;

    const writeBatch = async (batch: readonly CoreChunkRow[]): Promise<void> => {
      if (batch.length === 0) return;
      const vectors = await embedder.embed(batch.map(embeddingText));
      if (vectors.length !== batch.length) {
        throw new Error("SEMANTIC_BATCH_MISMATCH: embedder returned an unexpected row count");
      }

      semantic.exec("BEGIN IMMEDIATE");
      try {
        for (let index = 0; index < batch.length; index += 1) {
          const row = batch[index];
          const vector = vectors[index];
          if (!row || !vector || vector.length !== embedder.dimensions) {
            throw new Error("SEMANTIC_DIMENSION_MISMATCH: invalid embedding batch result");
          }
          const rowId = BigInt(row.id);
          insertChunk.run(rowId, row.chunk_id, row.content_hash);
          insertVector.run(rowId, float32Blob(vector));
        }
        semantic.exec("COMMIT");
        chunksEmbedded += batch.length;
      } catch (error) {
        if (semantic.isTransaction) semantic.exec("ROLLBACK");
        throw error;
      }
    };

    let batch: CoreChunkRow[] = [];
    for (const row of rows) {
      batch.push(row);
      if (batch.length < batchSize) continue;
      await writeBatch(batch);
      batch = [];
    }
    await writeBatch(batch);

    semantic.exec("PRAGMA optimize; PRAGMA wal_checkpoint(TRUNCATE);");
  } catch (error) {
    if (semantic.isTransaction) semantic.exec("ROLLBACK");
    semantic.close();
    await cleanup(buildPath);
    throw error;
  }

  semantic.close();
  await Promise.all([rm(`${buildPath}-wal`, { force: true }), rm(`${buildPath}-shm`, { force: true })]);
  try {
    await rename(buildPath, targetPath);
  } catch (error) {
    await cleanup(buildPath);
    throw error;
  }

  return {
    targetPath,
    model: embedder.model,
    dimensions: embedder.dimensions,
    chunksEmbedded,
    coreFingerprint,
  };
}
