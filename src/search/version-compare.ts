import type { DatabaseSync } from "node:sqlite";
import { normalizeIdentifier } from "../identifiers/normalize.js";

export type VersionKind = "api" | "minecraft";
export type VersionComparisonStatus = "added" | "removed" | "changed" | "unchanged" | "not_found";

export interface VersionCompareOptions {
  identifier: string;
  versionKind: VersionKind;
  fromVersion: string;
  toVersion: string;
  includePreview?: boolean;
}

export interface VersionSnapshot {
  requestedVersion: string;
  identifier: string;
  chunkId: string;
  documentId: string;
  title: string;
  content: string;
  contentHash: string;
  symbolKind?: string;
  path: string;
  kind: string;
  category: string;
  stability: string;
  lifecycle: string;
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

export interface VersionComparisonResult {
  requestedIdentifier: string;
  normalizedIdentifier: string;
  versionKind: VersionKind;
  fromVersion: string;
  toVersion: string;
  status: VersionComparisonStatus;
  from?: VersionSnapshot;
  to?: VersionSnapshot;
  changes: {
    content: boolean;
    stability: boolean;
    lifecycle: boolean;
    symbolKind: boolean;
  };
  warning?: string;
}

interface SnapshotRow {
  identifier: string;
  is_primary: number;
  chunk_id: string;
  document_id: string;
  title: string;
  content: string;
  content_hash: string;
  symbol_kind: string | null;
  path: string;
  kind: string;
  category: string;
  stability: string;
  lifecycle: string;
  channel: string;
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

function validate(options: VersionCompareOptions): void {
  const identifier = options.identifier.trim();
  if (identifier.length < 1 || identifier.length > 250) throw new RangeError("identifier must contain 1 to 250 characters");
  if (options.fromVersion.trim().length < 1 || options.fromVersion.length > 100) throw new RangeError("fromVersion must contain 1 to 100 characters");
  if (options.toVersion.trim().length < 1 || options.toVersion.length > 100) throw new RangeError("toVersion must contain 1 to 100 characters");
}

function snapshotFor(
  database: DatabaseSync,
  normalizedIdentifier: string,
  kind: VersionKind,
  version: string,
  includePreview: boolean,
): VersionSnapshot | undefined {
  const versionColumn = kind === "api" ? "d.api_version" : "d.minecraft_version";
  const previewSql = includePreview
    ? ""
    : "AND d.channel <> 'preview' AND c.stability NOT IN ('beta', 'experimental', 'internal')";
  const row = database.prepare(`
    SELECT
      COALESCE(c.identifier, i.identifier) AS identifier,
      i.is_primary,
      c.chunk_id,
      d.document_id,
      c.title,
      c.content,
      c.content_hash,
      c.symbol_kind,
      d.path,
      d.kind,
      d.category,
      c.stability,
      c.lifecycle,
      d.channel,
      s.id AS source_id,
      s.name AS source_name,
      s.tier AS source_tier,
      d.repository,
      d.revision,
      d.canonical_url,
      d.api_package,
      d.api_version,
      d.minecraft_version
    FROM identifiers i
    JOIN chunks c ON c.id = i.chunk_id
    JOIN documents d ON d.id = c.document_id
    JOIN sources s ON s.id = d.source_id
    WHERE i.normalized = ?
      AND ${versionColumn} = ?
      ${previewSql}
    ORDER BY
      i.is_primary DESC,
      s.tier ASC,
      CASE d.channel WHEN 'stable' THEN 0 WHEN 'preview' THEN 1 ELSE 2 END,
      CASE c.lifecycle WHEN 'active' THEN 0 WHEN 'deprecated' THEN 1 WHEN 'historical' THEN 2 WHEN 'removed' THEN 3 ELSE 4 END,
      c.ordinal ASC
    LIMIT 1
  `).get(normalizedIdentifier, version) as SnapshotRow | undefined;
  if (!row) return undefined;
  const content = row.content.length <= 4_000 ? row.content : `${row.content.slice(0, 3_999).trimEnd()}…`;
  return {
    requestedVersion: version,
    identifier: row.identifier,
    chunkId: row.chunk_id,
    documentId: row.document_id,
    title: row.title,
    content,
    contentHash: row.content_hash,
    ...(row.symbol_kind ? { symbolKind: row.symbol_kind } : {}),
    path: row.path,
    kind: row.kind,
    category: row.category,
    stability: row.stability,
    lifecycle: row.lifecycle,
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
  };
}

export function compareIdentifierVersions(database: DatabaseSync, options: VersionCompareOptions): VersionComparisonResult {
  validate(options);
  const requestedIdentifier = options.identifier.trim();
  const normalizedIdentifier = normalizeIdentifier(requestedIdentifier);
  const from = snapshotFor(database, normalizedIdentifier, options.versionKind, options.fromVersion, options.includePreview ?? false);
  const to = snapshotFor(database, normalizedIdentifier, options.versionKind, options.toVersion, options.includePreview ?? false);

  let status: VersionComparisonStatus;
  if (!from && !to) status = "not_found";
  else if (!from && to) status = "added";
  else if (from && !to) status = "removed";
  else if (from?.contentHash === to?.contentHash
    && from.stability === to.stability
    && from.lifecycle === to.lifecycle
    && from.symbolKind === to.symbolKind) status = "unchanged";
  else status = "changed";

  const changes = {
    content: Boolean(from && to && from.contentHash !== to.contentHash),
    stability: Boolean(from && to && from.stability !== to.stability),
    lifecycle: Boolean(from && to && from.lifecycle !== to.lifecycle),
    symbolKind: Boolean(from && to && from.symbolKind !== to.symbolKind),
  };

  let warning: string | undefined;
  if (status === "not_found") warning = `No indexed ${options.versionKind} evidence matched either requested version.`;
  else if (!from) warning = `No indexed ${options.versionKind} evidence matched fromVersion ${options.fromVersion}.`;
  else if (!to) warning = `No indexed ${options.versionKind} evidence matched toVersion ${options.toVersion}.`;

  return {
    requestedIdentifier,
    normalizedIdentifier,
    versionKind: options.versionKind,
    fromVersion: options.fromVersion,
    toVersion: options.toVersion,
    status,
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    changes,
    ...(warning ? { warning } : {}),
  };
}
