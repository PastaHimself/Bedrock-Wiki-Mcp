import { randomUUID } from "node:crypto";
import { rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { MAX_EMBED_TEXT_CHARS, SEMANTIC_SCHEMA_VERSION } from "./constants.js";
import {
  coreSemanticFingerprint,
  float32Blob,
  initializeSemanticSchema,
  openSemanticDatabase,
  semanticMeta,
} from "./database.js";
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

interface PreviousVectorRow {
  content_hash: string;
  embedding: Uint8Array;
}

export interface SemanticBuildResult {
  targetPath: string;
  model: string;
  dimensions: number;
  chunksEmbedded: number;
  chunksReused: number;
  chunksTotal: number;
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

function openReusableSemanticIndex(
  targetPath: string,
  embedder: TextEmbedder,
): DatabaseSync | undefined {
  let previous: DatabaseSync | undefined;
  try {
    previous = openSemanticDatabase(targetPath, "readonly");
    const meta = semanticMeta(previous);
    if (meta.schema_version !== String(SEMANTIC_SCHEMA_VERSION)
      || meta.model !== embedder.model
      || Number(meta.dimensions) !== embedder.dimensions) {
      previous.close();
      return undefined;
    }
    return previous;
  } catch {
    previous?.close();
    return undefined;
  }
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
  const previous = openReusableSemanticIndex(targetPath, embedder);
  const semantic = openSemanticDatabase(buildPath);
  let chunksEmbedded = 0;
  let chunksReused = 0;

  try {
    initializeSemanticSchema(semantic, embedder.dimensions, embedder.model, coreFingerprint);
    const insertChunk = semantic.prepare(
      "INSERT INTO semantic_chunks(rowid, chunk_id, content_hash) VALUES (?, ?, ?)",
    );
    const insertVector = semantic.prepare(
      "INSERT INTO chunk_vectors(rowid, embedding) VALUES (?, ?)",
    );
    const previousVector = previous?.prepare(`
      SELECT sc.content_hash, cv.embedding
      FROM semantic_chunks sc
      JOIN chunk_vectors cv ON cv.rowid = sc.rowid
      WHERE sc.chunk_id = ? AND sc.content_hash = ?
      LIMIT 1
    `);
    const rows = coreDatabase.prepare(`
      SELECT c.id, c.chunk_id, c.content_hash, c.title, c.identifier, c.content, d.path
      FROM chunks c
      JOIN documents d ON d.id = c.document_id
      ORDER BY c.id
    `).iterate() as Iterable<CoreChunkRow>;

    const writeBatch = async (batch: readonly CoreChunkRow[]): Promise<void> => {
      if (batch.length === 0) return;
      const reusable = new Map<number, Uint8Array>();
      const misses: Array<{ index: number; row: CoreChunkRow }> = [];

      for (const [index, row] of batch.entries()) {
        const prior = previousVector?.get(row.chunk_id, row.content_hash) as PreviousVectorRow | undefined;
        if (prior?.embedding && prior.embedding.byteLength === embedder.dimensions * Float32Array.BYTES_PER_ELEMENT) {
          reusable.set(index, prior.embedding);
        } else {
          misses.push({ index, row });
        }
      }

      const embeddedVectors = misses.length > 0
        ? await embedder.embed(misses.map((entry) => embeddingText(entry.row)))
        : [];
      if (embeddedVectors.length !== misses.length) {
        throw new Error("SEMANTIC_BATCH_MISMATCH: embedder returned an unexpected row count");
      }
      const newlyEmbedded = new Map<number, Float32Array>();
      for (const [missIndex, entry] of misses.entries()) {
        const vector = embeddedVectors[missIndex];
        if (!vector || vector.length !== embedder.dimensions) {
          throw new Error("SEMANTIC_DIMENSION_MISMATCH: invalid embedding batch result");
        }
        newlyEmbedded.set(entry.index, vector);
      }

      semantic.exec("BEGIN IMMEDIATE");
      try {
        for (const [index, row] of batch.entries()) {
          const rowId = BigInt(row.id);
          insertChunk.run(rowId, row.chunk_id, row.content_hash);
          const reused = reusable.get(index);
          if (reused) {
            insertVector.run(rowId, reused);
            chunksReused += 1;
            continue;
          }
          const vector = newlyEmbedded.get(index);
          if (!vector) throw new Error("SEMANTIC_BATCH_MISMATCH: missing embedding for changed chunk");
          insertVector.run(rowId, float32Blob(vector));
          chunksEmbedded += 1;
        }
        semantic.exec("COMMIT");
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
    previous?.close();
    await cleanup(buildPath);
    throw error;
  }

  semantic.close();
  previous?.close();
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
    chunksReused,
    chunksTotal: chunksEmbedded + chunksReused,
    coreFingerprint,
  };
}
