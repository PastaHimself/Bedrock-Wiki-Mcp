import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SEMANTIC_SCHEMA_VERSION } from "./constants.js";

export type SemanticDatabaseMode = "readwrite" | "readonly";

interface SqliteVecModule {
  load(database: DatabaseSync): void;
}

const require = createRequire(import.meta.url);

function loadSqliteVec(database: DatabaseSync): void {
  try {
    const sqliteVec = require("sqlite-vec") as SqliteVecModule;
    sqliteVec.load(database);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`SEMANTIC_DEPENDENCY_UNAVAILABLE: sqlite-vec could not be loaded: ${detail}`);
  }
}

export function openSemanticDatabase(
  path: string,
  mode: SemanticDatabaseMode = "readwrite",
): DatabaseSync {
  if (path !== ":memory:" && mode === "readwrite") mkdirSync(dirname(path), { recursive: true });
  const database = new DatabaseSync(path, {
    readOnly: mode === "readonly",
    timeout: 5_000,
    allowExtension: true,
  });
  try {
    loadSqliteVec(database);
  } catch (error) {
    database.close();
    throw error;
  }
  database.enableLoadExtension(false);
  database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  if (mode === "readonly") database.exec("PRAGMA query_only = ON;");
  else if (path !== ":memory:") database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
  return database;
}

export function initializeSemanticSchema(
  database: DatabaseSync,
  dimensions: number,
  model: string,
  coreFingerprint: string,
): void {
  if (!Number.isSafeInteger(dimensions) || dimensions < 1 || dimensions > 8192) {
    throw new RangeError("semantic dimensions must be an integer between 1 and 8192");
  }
  database.exec(`
    CREATE TABLE semantic_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;
    CREATE TABLE semantic_chunks (
      rowid INTEGER PRIMARY KEY,
      chunk_id TEXT NOT NULL UNIQUE,
      content_hash TEXT NOT NULL
    ) STRICT;
    CREATE VIRTUAL TABLE chunk_vectors USING vec0(
      embedding float[${dimensions}] distance_metric=cosine
    );
  `);
  const insert = database.prepare("INSERT INTO semantic_meta(key, value) VALUES (?, ?)");
  insert.run("schema_version", String(SEMANTIC_SCHEMA_VERSION));
  insert.run("dimensions", String(dimensions));
  insert.run("model", model);
  insert.run("core_fingerprint", coreFingerprint);
  insert.run("built_at", new Date().toISOString());
}

export function semanticMeta(database: DatabaseSync): Record<string, string> {
  const rows = database.prepare("SELECT key, value FROM semantic_meta").all() as unknown as Array<{ key: string; value: string }>;
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

export function coreSemanticFingerprint(database: DatabaseSync): string {
  const hash = createHash("sha256");
  const rows = database.prepare(`
    SELECT c.chunk_id, c.content_hash
    FROM chunks c
    ORDER BY c.chunk_id
  `).iterate() as Iterable<{ chunk_id: string; content_hash: string }>;
  let count = 0;
  for (const row of rows) {
    hash.update(row.chunk_id);
    hash.update("\u0000");
    hash.update(row.content_hash);
    hash.update("\n");
    count += 1;
  }
  hash.update(`count:${count}`);
  return `sha256:${hash.digest("hex")}`;
}

export function float32Blob(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
}
