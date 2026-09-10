import type { DatabaseSync } from "node:sqlite";
import { normalizeIdentifier } from "../identifiers/normalize.js";

export interface RelationshipLookupOptions {
  identifier: string;
  relation?: string;
  depth?: number;
  limit?: number;
}

export interface SymbolRelationship {
  depth: number;
  direction: "outgoing" | "incoming";
  fromIdentifier: string;
  relation: string;
  toIdentifier: string;
  sourceChunkId?: string;
  sourceDocumentId?: string;
  sourcePath?: string;
  sourceId?: string;
  sourceName?: string;
  sourceTier?: number;
  channel?: string;
  apiPackage?: string;
  apiVersion?: string;
  minecraftVersion?: string;
}

export interface RelationshipLookupResult {
  requestedIdentifier: string;
  normalizedIdentifier: string;
  canonicalIdentifiers: string[];
  relationships: SymbolRelationship[];
  truncated: boolean;
}

interface EdgeRow {
  from_identifier: string;
  relation: string;
  to_identifier: string;
  chunk_id: string | null;
  document_id: string | null;
  path: string | null;
  source_id: string | null;
  source_name: string | null;
  source_tier: number | null;
  channel: string | null;
  api_package: string | null;
  api_version: string | null;
  minecraft_version: string | null;
}

function validateOptions(options: RelationshipLookupOptions): { identifier: string; depth: number; limit: number } {
  const identifier = options.identifier.trim();
  const depth = options.depth ?? 1;
  const limit = options.limit ?? 40;
  if (identifier.length < 1 || identifier.length > 250) throw new RangeError("identifier must contain 1 to 250 characters");
  if (!Number.isSafeInteger(depth) || depth < 1 || depth > 3) throw new RangeError("depth must be an integer between 1 and 3");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RangeError("limit must be an integer between 1 and 100");
  if ((options.relation?.length ?? 0) > 80) throw new RangeError("relation may contain at most 80 characters");
  return { identifier, depth, limit };
}

function canonicalIdentifiers(database: DatabaseSync, normalized: string, requested: string): string[] {
  const rows = database.prepare(`
    SELECT DISTINCT COALESCE(c.identifier, i.identifier) AS identifier, i.is_primary
    FROM identifiers i
    JOIN chunks c ON c.id = i.chunk_id
    WHERE i.normalized = ?
    ORDER BY i.is_primary DESC, identifier ASC
    LIMIT 16
  `).all(normalized) as unknown as Array<{ identifier: string; is_primary: number }>;
  const values = rows.map((row) => row.identifier).filter(Boolean);
  return values.length > 0 ? [...new Set(values)] : [requested];
}

function edgeRows(database: DatabaseSync, identifiers: readonly string[], relation?: string): EdgeRow[] {
  const normalized = [...new Set(identifiers.map(normalizeIdentifier))];
  if (normalized.length === 0) return [];
  const placeholders = normalized.map(() => "?").join(", ");
  const relationSql = relation ? "AND e.relation = ?" : "";
  const parameters = [...normalized, ...normalized, ...(relation ? [relation] : [])];
  return database.prepare(`
    SELECT DISTINCT
      e.from_identifier,
      e.relation,
      e.to_identifier,
      c.chunk_id,
      d.document_id,
      d.path,
      s.id AS source_id,
      s.name AS source_name,
      s.tier AS source_tier,
      d.channel,
      d.api_package,
      d.api_version,
      d.minecraft_version
    FROM symbol_edges e
    LEFT JOIN chunks c ON c.id = e.source_chunk_id
    LEFT JOIN documents d ON d.id = c.document_id
    LEFT JOIN sources s ON s.id = d.source_id
    WHERE (
      lower(e.from_identifier) IN (${placeholders})
      OR lower(e.to_identifier) IN (${placeholders})
    )
    ${relationSql}
    ORDER BY e.relation ASC, e.from_identifier ASC, e.to_identifier ASC
  `).all(...parameters) as unknown as EdgeRow[];
}

function relationship(row: EdgeRow, frontier: ReadonlySet<string>, depth: number): SymbolRelationship {
  const fromNormalized = normalizeIdentifier(row.from_identifier);
  const direction: "outgoing" | "incoming" = frontier.has(fromNormalized) ? "outgoing" : "incoming";
  return {
    depth,
    direction,
    fromIdentifier: row.from_identifier,
    relation: row.relation,
    toIdentifier: row.to_identifier,
    ...(row.chunk_id ? { sourceChunkId: row.chunk_id } : {}),
    ...(row.document_id ? { sourceDocumentId: row.document_id } : {}),
    ...(row.path ? { sourcePath: row.path } : {}),
    ...(row.source_id ? { sourceId: row.source_id } : {}),
    ...(row.source_name ? { sourceName: row.source_name } : {}),
    ...(row.source_tier !== null ? { sourceTier: row.source_tier } : {}),
    ...(row.channel ? { channel: row.channel } : {}),
    ...(row.api_package ? { apiPackage: row.api_package } : {}),
    ...(row.api_version ? { apiVersion: row.api_version } : {}),
    ...(row.minecraft_version ? { minecraftVersion: row.minecraft_version } : {}),
  };
}

export function resolveRelationships(database: DatabaseSync, options: RelationshipLookupOptions): RelationshipLookupResult {
  const { identifier, depth, limit } = validateOptions(options);
  const normalizedIdentifier = normalizeIdentifier(identifier);
  const canonical = canonicalIdentifiers(database, normalizedIdentifier, identifier);
  let frontier = new Set(canonical.map(normalizeIdentifier));
  const visited = new Set(frontier);
  const relationships: SymbolRelationship[] = [];
  const seenEdges = new Set<string>();
  let truncated = false;

  for (let currentDepth = 1; currentDepth <= depth && frontier.size > 0; currentDepth += 1) {
    const rows = edgeRows(database, [...frontier], options.relation);
    const next = new Set<string>();
    for (const row of rows) {
      const key = `${normalizeIdentifier(row.from_identifier)}\u0000${row.relation}\u0000${normalizeIdentifier(row.to_identifier)}`;
      if (seenEdges.has(key)) continue;
      seenEdges.add(key);
      if (relationships.length >= limit) {
        truncated = true;
        break;
      }
      relationships.push(relationship(row, frontier, currentDepth));
      for (const value of [row.from_identifier, row.to_identifier]) {
        const normalized = normalizeIdentifier(value);
        if (!visited.has(normalized)) next.add(normalized);
      }
    }
    if (truncated) break;
    for (const value of next) visited.add(value);
    frontier = next;
  }

  return {
    requestedIdentifier: identifier,
    normalizedIdentifier,
    canonicalIdentifiers: canonical,
    relationships,
    truncated,
  };
}
