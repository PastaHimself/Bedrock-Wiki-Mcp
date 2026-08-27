import type { DatabaseSync } from "node:sqlite";
import { SEMANTIC_SCHEMA_VERSION } from "./constants.js";
import { float32Blob, openSemanticDatabase, semanticMeta } from "./database.js";
import type { TextEmbedder } from "./embedder.js";

export interface SemanticHit {
  chunkId: string;
  distance: number;
}

export interface SemanticRetriever {
  search(query: string, limit?: number): Promise<SemanticHit[]>;
}

interface SemanticRow {
  chunk_id: string;
  distance: number;
}

export class SqliteSemanticRetriever implements SemanticRetriever {
  constructor(
    private readonly database: DatabaseSync,
    private readonly embedder: TextEmbedder,
    private readonly defaultLimit = 40,
  ) {}

  async search(query: string, limit = this.defaultLimit): Promise<SemanticHit[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError("semantic search limit must be an integer between 1 and 100");
    }
    const [vector] = await this.embedder.embed([query]);
    if (!vector || vector.length !== this.embedder.dimensions) {
      throw new Error("SEMANTIC_QUERY_EMBEDDING_INVALID: query embedding has unexpected dimensions");
    }
    const rows = this.database.prepare(`
      SELECT sc.chunk_id, v.distance
      FROM chunk_vectors v
      JOIN semantic_chunks sc ON sc.rowid = v.rowid
      WHERE v.embedding MATCH ?
        AND k = ?
      ORDER BY v.distance
    `).all(float32Blob(vector), limit) as unknown as SemanticRow[];
    return rows.map((row) => ({ chunkId: row.chunk_id, distance: row.distance }));
  }

  close(): void {
    this.database.close();
  }
}

export function openSemanticRetriever(
  path: string,
  embedder: TextEmbedder,
  expectedCoreFingerprint: string,
  defaultLimit = 40,
): SqliteSemanticRetriever {
  const database = openSemanticDatabase(path, "readonly");
  try {
    const meta = semanticMeta(database);
    if (meta.schema_version !== String(SEMANTIC_SCHEMA_VERSION)) {
      throw new Error(`SEMANTIC_SCHEMA_MISMATCH: expected ${SEMANTIC_SCHEMA_VERSION}, found ${meta.schema_version ?? "missing"}`);
    }
    if (meta.model !== embedder.model) {
      throw new Error(`SEMANTIC_MODEL_MISMATCH: index uses ${meta.model ?? "unknown"}, configured model is ${embedder.model}`);
    }
    if (Number(meta.dimensions) !== embedder.dimensions) {
      throw new Error(`SEMANTIC_DIMENSION_MISMATCH: index uses ${meta.dimensions ?? "unknown"}, model uses ${embedder.dimensions}`);
    }
    if (meta.core_fingerprint !== expectedCoreFingerprint) {
      throw new Error("SEMANTIC_INDEX_STALE: semantic index does not match the current Bedrock index");
    }
    return new SqliteSemanticRetriever(database, embedder, defaultLimit);
  } catch (error) {
    database.close();
    throw error;
  }
}
