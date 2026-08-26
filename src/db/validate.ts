import type { DatabaseSync } from "node:sqlite";
import { getSchemaVersion } from "./migrate.js";

export interface IndexValidationReport {
  ok: boolean;
  errors: string[];
  schemaVersion: number;
  sources: number;
  documents: number;
  chunks: number;
  identifiers: number;
  ftsRows: number;
  missingFtsRows: number;
  orphanFtsRows: number;
}

function count(database: DatabaseSync, table: string): number {
  const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number } | undefined;
  return row?.count ?? 0;
}

function scalarCount(database: DatabaseSync, sql: string): number {
  const row = database.prepare(sql).get() as { count: number } | undefined;
  return row?.count ?? 0;
}

export function validateIndex(database: DatabaseSync): IndexValidationReport {
  const errors: string[] = [];

  const integrityRows = database.prepare("PRAGMA integrity_check").all() as unknown as Array<{ integrity_check: string }>;
  for (const row of integrityRows) {
    if (row.integrity_check !== "ok") errors.push(`integrity_check: ${row.integrity_check}`);
  }

  const foreignKeyRows = database.prepare("PRAGMA foreign_key_check").all() as unknown[];
  if (foreignKeyRows.length > 0) errors.push(`foreign_key_check reported ${foreignKeyRows.length} violation(s)`);

  const sources = count(database, "sources");
  const documents = count(database, "documents");
  const chunks = count(database, "chunks");
  const identifiers = count(database, "identifiers");
  const ftsRows = count(database, "chunks_fts");
  const missingFtsRows = scalarCount(database, `
    SELECT COUNT(*) AS count
    FROM chunks c
    LEFT JOIN chunks_fts f ON f.rowid = c.id
    WHERE f.rowid IS NULL
  `);
  const orphanFtsRows = scalarCount(database, `
    SELECT COUNT(*) AS count
    FROM chunks_fts f
    LEFT JOIN chunks c ON c.id = f.rowid
    WHERE c.id IS NULL
  `);

  if (chunks !== ftsRows) errors.push(`FTS row count ${ftsRows} does not match chunk count ${chunks}`);
  if (missingFtsRows > 0) errors.push(`FTS index is missing ${missingFtsRows} chunk row(s)`);
  if (orphanFtsRows > 0) errors.push(`FTS index contains ${orphanFtsRows} orphan row(s)`);

  return {
    ok: errors.length === 0,
    errors,
    schemaVersion: getSchemaVersion(database),
    sources,
    documents,
    chunks,
    identifiers,
    ftsRows,
    missingFtsRows,
    orphanFtsRows,
  };
}
