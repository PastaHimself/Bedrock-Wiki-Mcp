import type { DatabaseSync } from "node:sqlite";
import { normalizeIdentifier } from "../identifiers/normalize.js";
import { exactIdentifierSearch, type ExactIdentifierHit } from "./exact.js";
import { versionCompatibility, versionMatchScore } from "./version.js";

export interface DefinitionLookupOptions {
  identifier: string;
  minecraftVersion?: string;
  apiVersion?: string;
  includePreview?: boolean;
  includeHistorical?: boolean;
}

export interface DefinitionExample {
  chunkId: string;
  documentId: string;
  title: string;
  content: string;
  path: string;
  channel: string;
  sourceId: string;
  sourceName: string;
  sourceTier: number;
  repository?: string;
  revision?: string;
  canonicalUrl?: string;
  apiPackage?: string;
  apiVersion?: string;
  minecraftVersion?: string;
}

export interface DefinitionLookupResult {
  identifier: string;
  definitions: ExactIdentifierHit[];
  examples: DefinitionExample[];
  stableDefinitionFound: boolean;
  warning?: string;
}

interface ExampleRow {
  chunk_id: string;
  document_id: string;
  title: string;
  content: string;
  path: string;
  channel: string;
  stability: string;
  lifecycle: string;
  source_id: string;
  source_name: string;
  source_tier: number;
  repository: string | null;
  revision: string | null;
  canonical_url: string | null;
  api_package: string | null;
  api_version: string | null;
  minecraft_version: string | null;
}

function versionAllowed(hit: Pick<ExactIdentifierHit, "minecraftVersion" | "apiVersion">, options: DefinitionLookupOptions): boolean {
  if (versionCompatibility(options.minecraftVersion, hit.minecraftVersion) === "mismatch") return false;
  if (versionCompatibility(options.apiVersion, hit.apiVersion) === "mismatch") return false;
  return true;
}

function isAllowed(hit: ExactIdentifierHit, options: DefinitionLookupOptions): boolean {
  if (!(options.includePreview ?? false) && (hit.channel === "preview" || ["beta", "experimental", "internal"].includes(hit.stability))) return false;
  if (!(options.includeHistorical ?? false) && ["historical", "removed"].includes(hit.lifecycle)) return false;
  return versionAllowed(hit, options);
}

function definitionLike(hit: ExactIdentifierHit): boolean {
  return !["code", "example"].includes(hit.kind);
}

function versionScore(hit: Pick<ExactIdentifierHit, "minecraftVersion" | "apiVersion">, options: DefinitionLookupOptions): number {
  return versionMatchScore(options.minecraftVersion, hit.minecraftVersion)
    + versionMatchScore(options.apiVersion, hit.apiVersion);
}

function exampleAllowed(row: ExampleRow, options: DefinitionLookupOptions): boolean {
  if (!(options.includePreview ?? false) && (row.channel === "preview" || ["beta", "experimental", "internal"].includes(row.stability))) return false;
  if (!(options.includeHistorical ?? false) && ["historical", "removed"].includes(row.lifecycle)) return false;
  return versionCompatibility(options.minecraftVersion, row.minecraft_version ?? undefined) !== "mismatch"
    && versionCompatibility(options.apiVersion, row.api_version ?? undefined) !== "mismatch";
}

function examplesFor(database: DatabaseSync, identifier: string, options: DefinitionLookupOptions, excludedChunkIds: ReadonlySet<string>): DefinitionExample[] {
  const rows = database.prepare(`
    SELECT DISTINCT
      c.chunk_id, d.document_id, c.title, c.content, d.path, d.channel,
      c.stability, c.lifecycle, s.id AS source_id, s.name AS source_name, s.tier AS source_tier,
      d.repository, d.revision, d.canonical_url, d.api_package, d.api_version, d.minecraft_version
    FROM identifiers i
    JOIN chunks c ON c.id = i.chunk_id
    JOIN documents d ON d.id = c.document_id
    JOIN sources s ON s.id = d.source_id
    WHERE i.normalized = ?
      AND (d.kind IN ('code', 'example') OR c.chunk_type = 'code-block')
    ORDER BY s.tier ASC,
      CASE d.channel WHEN 'stable' THEN 0 WHEN 'preview' THEN 1 ELSE 2 END,
      c.ordinal ASC
    LIMIT 30
  `).all(normalizeIdentifier(identifier)) as unknown as ExampleRow[];

  const examples: DefinitionExample[] = [];
  const seenDocuments = new Set<string>();
  for (const row of rows) {
    if (examples.length >= 2) break;
    if (excludedChunkIds.has(row.chunk_id) || seenDocuments.has(row.document_id) || !exampleAllowed(row, options)) continue;
    seenDocuments.add(row.document_id);
    const content = row.content.length <= 1_600 ? row.content : `${row.content.slice(0, 1_599).trimEnd()}…`;
    examples.push({
      chunkId: row.chunk_id,
      documentId: row.document_id,
      title: row.title,
      content,
      path: row.path,
      channel: row.channel,
      sourceId: row.source_id,
      sourceName: row.source_name,
      sourceTier: row.source_tier,
      ...(row.repository ? { repository: row.repository } : {}),
      ...(row.revision ? { revision: row.revision } : {}),
      ...(row.canonical_url ? { canonicalUrl: row.canonical_url } : {}),
      ...(row.api_package ? { apiPackage: row.api_package } : {}),
      ...(row.api_version ? { apiVersion: row.api_version } : {}),
      ...(row.minecraft_version ? { minecraftVersion: row.minecraft_version } : {}),
    });
  }
  return examples;
}

function rankDefinitions(hits: readonly ExactIdentifierHit[], options: DefinitionLookupOptions): ExactIdentifierHit[] {
  const allowed = hits.filter((hit) => isAllowed(hit, options));
  const reference = allowed.filter(definitionLike);
  const pool = reference.length > 0 ? reference : allowed;
  return pool
    .sort((a, b) => versionScore(b, options) - versionScore(a, options) || a.sourceTier - b.sourceTier)
    .slice(0, 3);
}

export function getDefinition(database: DatabaseSync, options: DefinitionLookupOptions): DefinitionLookupResult {
  const identifier = options.identifier.trim();
  if (identifier.length < 1 || identifier.length > 250) throw new RangeError("identifier must contain 1 to 250 characters");

  const all = exactIdentifierSearch(database, identifier, 30);
  let definitions = rankDefinitions(all, options);
  const stableDefinitionFound = definitions.some((hit) => hit.channel === "stable" && hit.stability === "stable" && hit.lifecycle === "active");

  let warning: string | undefined;
  if (definitions.length === 0 && !(options.includePreview ?? false)) {
    const previewCandidates = all
      .filter((hit) => !["historical", "removed"].includes(hit.lifecycle))
      .filter((hit) => versionAllowed(hit, options));
    const reference = previewCandidates.filter(definitionLike);
    const pool = reference.length > 0 ? reference : previewCandidates;
    const previewFallback = pool
      .sort((a, b) => versionScore(b, options) - versionScore(a, options) || a.sourceTier - b.sourceTier)
      .slice(0, 3);
    if (previewFallback.length > 0) {
      definitions = previewFallback;
      warning = "No current stable definition was found; returning preview/beta material as an explicit fallback.";
    }
  }

  if (definitions.length === 0 && !warning) warning = "No definition was found for this exact identifier and requested version constraints.";
  const excluded = new Set(definitions.map((definition) => definition.chunkId));
  const exampleOptions = definitions.some((definition) => definition.channel === "preview") && !(options.includePreview ?? false)
    ? { ...options, includePreview: true }
    : options;

  return {
    identifier,
    definitions,
    examples: examplesFor(database, identifier, exampleOptions, excluded),
    stableDefinitionFound,
    ...(warning ? { warning } : {}),
  };
}
