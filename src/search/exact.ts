import type { DatabaseSync } from "node:sqlite";
import { normalizeIdentifier } from "../identifiers/normalize.js";

export interface ExactIdentifierHit {
  chunkId: string;
  documentId: string;
  ordinal: number;
  identifier: string;
  title: string;
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
  isPrimary: boolean;
  repository?: string;
  revision?: string;
  canonicalUrl?: string;
  revisionUrl?: string;
  apiPackage?: string;
  apiVersion?: string;
  minecraftVersion?: string;
}

interface ExactIdentifierRow {
  chunk_id: string;
  document_id: string;
  ordinal: number;
  identifier: string;
  title: string;
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
  is_primary: number;
  repository: string | null;
  revision: string | null;
  canonical_url: string | null;
  revision_url: string | null;
  api_package: string | null;
  api_version: string | null;
  minecraft_version: string | null;
}

function validateLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw new RangeError("limit must be an integer between 1 and 50");
  }
  return limit;
}

export function exactIdentifierSearch(
  database: DatabaseSync,
  identifier: string,
  limit = 10,
): ExactIdentifierHit[] {
  const normalized = normalizeIdentifier(identifier);
  if (normalized.length === 0) throw new Error("identifier must not be empty");
  const validatedLimit = validateLimit(limit);

  const rows = database.prepare(`
    SELECT
      c.chunk_id,
      d.document_id,
      c.ordinal,
      COALESCE(c.identifier, i.identifier) AS identifier,
      c.title,
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
      CASE WHEN c.identifier IS NOT NULL THEN 1 ELSE i.is_primary END AS is_primary,
      d.repository,
      d.revision,
      d.canonical_url,
      d.revision_url,
      d.api_package,
      d.api_version,
      d.minecraft_version
    FROM identifiers i
    JOIN chunks c ON c.id = i.chunk_id
    JOIN documents d ON d.id = c.document_id
    JOIN sources s ON s.id = d.source_id
    WHERE i.normalized = ?
    ORDER BY
      CASE c.lifecycle
        WHEN 'active' THEN 0
        WHEN 'deprecated' THEN 1
        WHEN 'historical' THEN 2
        ELSE 3
      END,
      CASE c.stability
        WHEN 'stable' THEN 0
        WHEN 'beta' THEN 1
        WHEN 'experimental' THEN 2
        ELSE 3
      END,
      CASE d.channel WHEN 'stable' THEN 0 WHEN 'preview' THEN 1 ELSE 2 END,
      s.tier ASC,
      i.is_primary DESC,
      CASE i.alias_type WHEN 'exact' THEN 0 ELSE 1 END,
      c.ordinal ASC
    LIMIT ?
  `).all(normalized, Math.min(200, validatedLimit * 4)) as unknown as ExactIdentifierRow[];

  const seenChunks = new Set<string>();
  const results: ExactIdentifierHit[] = [];
  for (const row of rows) {
    if (seenChunks.has(row.chunk_id)) continue;
    seenChunks.add(row.chunk_id);
    results.push({
      chunkId: row.chunk_id,
      documentId: row.document_id,
      ordinal: row.ordinal,
      identifier: row.identifier,
      title: row.title,
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
      isPrimary: row.is_primary === 1,
      ...(row.repository ? { repository: row.repository } : {}),
      ...(row.revision ? { revision: row.revision } : {}),
      ...(row.canonical_url ? { canonicalUrl: row.canonical_url } : {}),
      ...(row.revision_url ? { revisionUrl: row.revision_url } : {}),
      ...(row.api_package ? { apiPackage: row.api_package } : {}),
      ...(row.api_version ? { apiVersion: row.api_version } : {}),
      ...(row.minecraft_version ? { minecraftVersion: row.minecraft_version } : {}),
    });
    if (results.length >= validatedLimit) break;
  }

  return results;
}
