import type { DatabaseSync } from "node:sqlite";

const QUERY_TOKEN = /[\p{L}\p{N}_@.$:-]+/gu;

export interface LexicalSearchHit {
  chunkId: string;
  documentId: string;
  ordinal: number;
  title: string;
  identifier?: string;
  content: string;
  path: string;
  kind: string;
  category: string;
  stability: string;
  lifecycle: string;
  channel: string;
  sourceId: string;
  sourceName: string;
  sourceType: string;
  sourceTier: number;
  bm25Rank: number;
  repository?: string;
  revision?: string;
  canonicalUrl?: string;
  revisionUrl?: string;
  apiPackage?: string;
  apiVersion?: string;
  minecraftVersion?: string;
}

interface LexicalRow {
  chunk_id: string;
  document_id: string;
  ordinal: number;
  title: string;
  identifier: string | null;
  content: string;
  path: string;
  kind: string;
  category: string;
  stability: string;
  lifecycle: string;
  channel: string;
  source_id: string;
  source_name: string;
  source_type: string;
  source_tier: number;
  bm25_rank: number;
  repository: string | null;
  revision: string | null;
  canonical_url: string | null;
  revision_url: string | null;
  api_package: string | null;
  api_version: string | null;
  minecraft_version: string | null;
}

function quoteFtsToken(token: string): string {
  return `"${token.replace(/"/g, '""')}"`;
}

export function compileFtsQuery(query: string): string {
  const tokens = [...query.matchAll(QUERY_TOKEN)]
    .map((match) => match[0]?.trim())
    .filter((token): token is string => Boolean(token));
  const unique = [...new Set(tokens)];
  if (unique.length === 0) throw new Error("query must contain searchable text");
  return unique.map(quoteFtsToken).join(" AND ");
}

function validateLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError("limit must be an integer between 1 and 100");
  }
  return limit;
}

export function lexicalSearch(database: DatabaseSync, query: string, limit = 50): LexicalSearchHit[] {
  const ftsQuery = compileFtsQuery(query);
  const rows = database.prepare(`
    SELECT
      c.chunk_id,
      d.document_id,
      c.ordinal,
      c.title,
      c.identifier,
      c.content,
      d.path,
      d.kind,
      d.category,
      c.stability,
      c.lifecycle,
      d.channel,
      s.id AS source_id,
      s.name AS source_name,
      s.source_type AS source_type,
      s.tier AS source_tier,
      bm25(chunks_fts, 12.0, 6.0, 4.0, 10.0, 1.0, 2.0) AS bm25_rank,
      d.repository,
      d.revision,
      d.canonical_url,
      d.revision_url,
      d.api_package,
      d.api_version,
      d.minecraft_version
    FROM chunks_fts
    JOIN chunks c ON c.id = chunks_fts.rowid
    JOIN documents d ON d.id = c.document_id
    JOIN sources s ON s.id = d.source_id
    WHERE chunks_fts MATCH ?
    ORDER BY bm25_rank ASC
    LIMIT ?
  `).all(ftsQuery, validateLimit(limit)) as unknown as LexicalRow[];

  return rows.map((row) => ({
    chunkId: row.chunk_id,
    documentId: row.document_id,
    ordinal: row.ordinal,
    title: row.title,
    ...(row.identifier ? { identifier: row.identifier } : {}),
    content: row.content,
    path: row.path,
    kind: row.kind,
    category: row.category,
    stability: row.stability,
    lifecycle: row.lifecycle,
    channel: row.channel,
    sourceId: row.source_id,
    sourceName: row.source_name,
    sourceType: row.source_type,
    sourceTier: row.source_tier,
    bm25Rank: row.bm25_rank,
    ...(row.repository ? { repository: row.repository } : {}),
    ...(row.revision ? { revision: row.revision } : {}),
    ...(row.canonical_url ? { canonicalUrl: row.canonical_url } : {}),
    ...(row.revision_url ? { revisionUrl: row.revision_url } : {}),
    ...(row.api_package ? { apiPackage: row.api_package } : {}),
    ...(row.api_version ? { apiVersion: row.api_version } : {}),
    ...(row.minecraft_version ? { minecraftVersion: row.minecraft_version } : {}),
  }));
}
