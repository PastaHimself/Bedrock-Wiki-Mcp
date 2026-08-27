import { stat } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import { validateIndex, type IndexValidationReport } from "../db/validate.js";

export interface SourceStatus {
  id: string;
  name: string;
  tier: number;
  channel: string;
  branch?: string;
  revision?: string;
  lastIndexedAt?: string;
  documents: number;
  chunks: number;
  identifiers: number;
}

export interface IndexStatusReport {
  indexPath: string;
  indexBytes?: number;
  validation: IndexValidationReport;
  lastIndexedAt?: string;
  sources: SourceStatus[];
}

interface SourceStatusRow {
  id: string;
  name: string;
  tier: number;
  channel: string;
  branch: string | null;
  current_revision: string | null;
  last_indexed_at: string | null;
  documents: number;
  chunks: number;
  identifiers: number;
}

export async function readIndexStatus(
  database: DatabaseSync,
  indexPath: string,
): Promise<IndexStatusReport> {
  const validation = validateIndex(database);
  const rows = database.prepare(`
    SELECT
      s.id,
      s.name,
      s.tier,
      s.channel,
      s.branch,
      s.current_revision,
      s.last_indexed_at,
      (SELECT COUNT(*) FROM documents d WHERE d.source_id = s.id) AS documents,
      (
        SELECT COUNT(*)
        FROM chunks c
        JOIN documents d ON d.id = c.document_id
        WHERE d.source_id = s.id
      ) AS chunks,
      (
        SELECT COUNT(*)
        FROM identifiers i
        JOIN chunks c ON c.id = i.chunk_id
        JOIN documents d ON d.id = c.document_id
        WHERE d.source_id = s.id
      ) AS identifiers
    FROM sources s
    ORDER BY s.tier ASC, s.id ASC
  `).all() as unknown as SourceStatusRow[];

  let indexBytes: number | undefined;
  try {
    indexBytes = (await stat(indexPath)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const sources = rows.map((row): SourceStatus => ({
    id: row.id,
    name: row.name,
    tier: row.tier,
    channel: row.channel,
    documents: row.documents,
    chunks: row.chunks,
    identifiers: row.identifiers,
    ...(row.branch ? { branch: row.branch } : {}),
    ...(row.current_revision ? { revision: row.current_revision } : {}),
    ...(row.last_indexed_at ? { lastIndexedAt: row.last_indexed_at } : {}),
  }));
  const lastIndexedAt = sources
    .map((source) => source.lastIndexedAt)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1);

  return {
    indexPath,
    ...(indexBytes !== undefined ? { indexBytes } : {}),
    validation,
    ...(lastIndexedAt ? { lastIndexedAt } : {}),
    sources,
  };
}

export function formatIndexStatus(report: IndexStatusReport): string {
  const lines = [
    `Index: ${report.indexPath}`,
    `Schema: ${report.validation.schemaVersion}`,
    `Integrity: ${report.validation.ok ? "ok" : "FAILED"}`,
    `Documents: ${report.validation.documents}`,
    `Chunks: ${report.validation.chunks}`,
    `Identifiers: ${report.validation.identifiers}`,
    `FTS rows: ${report.validation.ftsRows}`,
  ];
  if (report.indexBytes !== undefined) lines.push(`Index bytes: ${report.indexBytes}`);
  if (report.lastIndexedAt) lines.push(`Last indexed: ${report.lastIndexedAt}`);
  if (report.validation.errors.length > 0) {
    for (const error of report.validation.errors) lines.push(`ERROR: ${error}`);
  }
  if (report.sources.length > 0) {
    lines.push("Sources:");
    for (const source of report.sources) {
      const revision = source.revision ? ` ${source.revision.slice(0, 12)}` : "";
      lines.push(
        `  ${source.id} [tier ${source.tier}/${source.channel}]${revision}: ${source.documents} docs, ${source.chunks} chunks, ${source.identifiers} identifiers`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}
