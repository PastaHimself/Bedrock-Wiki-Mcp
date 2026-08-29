import type { DatabaseSync } from "node:sqlite";

export interface KnowledgeSourceSummary {
  id: string;
  name: string;
  type: string;
  tier: number;
  channel: string;
  enabled: boolean;
  health: "healthy" | "empty";
  documents: number;
  chunks: number;
  duplicateChunks: number;
  duplicatePercent: number;
  repository?: string;
  branch?: string;
  revision?: string;
  lastIndexedAt?: string;
}

interface SourceRow {
  id: string;
  name: string;
  source_type: string;
  tier: number;
  channel: string;
  repository: string | null;
  branch: string | null;
  current_revision: string | null;
  last_indexed_at: string | null;
  documents: number;
  chunks: number;
  duplicate_chunks: number;
}

export function listKnowledgeSources(database: DatabaseSync): KnowledgeSourceSummary[] {
  const rows = database.prepare(`
    SELECT
      s.id, s.name, s.source_type, s.tier, s.channel, s.repository, s.branch,
      s.current_revision, s.last_indexed_at,
      COUNT(DISTINCT d.id) AS documents,
      COUNT(c.id) AS chunks,
      COALESCE(SUM(CASE WHEN c.id IS NOT NULL AND EXISTS (
        SELECT 1
        FROM chunks other_c
        JOIN documents other_d ON other_d.id = other_c.document_id
        JOIN sources other_s ON other_s.id = other_d.source_id
        WHERE other_c.content_hash = c.content_hash
          AND other_d.source_id <> d.source_id
          AND other_s.tier <= s.tier
      ) THEN 1 ELSE 0 END), 0) AS duplicate_chunks
    FROM sources s
    LEFT JOIN documents d ON d.source_id = s.id
    LEFT JOIN chunks c ON c.document_id = d.id
    GROUP BY s.id
    ORDER BY s.tier ASC, s.name ASC
  `).all() as unknown as SourceRow[];

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    type: row.source_type,
    tier: row.tier,
    channel: row.channel,
    enabled: true,
    health: row.documents > 0 && row.chunks > 0 ? "healthy" : "empty",
    documents: row.documents,
    chunks: row.chunks,
    duplicateChunks: row.duplicate_chunks,
    duplicatePercent: row.chunks > 0 ? Number((row.duplicate_chunks / row.chunks * 100).toFixed(2)) : 0,
    ...(row.repository ? { repository: row.repository } : {}),
    ...(row.branch ? { branch: row.branch } : {}),
    ...(row.current_revision ? { revision: row.current_revision } : {}),
    ...(row.last_indexed_at ? { lastIndexedAt: row.last_indexed_at } : {}),
  }));
}

export interface KnowledgeCategorySummary {
  id: string;
  documents: number;
  chunks: number;
}

export function listKnowledgeCategories(database: DatabaseSync): KnowledgeCategorySummary[] {
  return database.prepare(`
    SELECT d.category AS id, COUNT(DISTINCT d.id) AS documents, COUNT(c.id) AS chunks
    FROM documents d
    LEFT JOIN chunks c ON c.document_id = d.id
    GROUP BY d.category
    ORDER BY d.category ASC
  `).all() as unknown as KnowledgeCategorySummary[];
}
