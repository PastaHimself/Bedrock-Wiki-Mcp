import type { DatabaseSync } from "node:sqlite";

const DOCUMENT_ID = /^doc_[a-f0-9]{24}$/;
const CHUNK_ID = /^chk_[a-f0-9]{24}$/;

export type FetchTargetKind = "document" | "chunk";

export interface FetchKnowledgeOptions {
  id: string;
  contextBefore?: number;
  contextAfter?: number;
  maxChars?: number;
}

export interface FetchChunk {
  chunkId: string;
  ordinal: number;
  title: string;
  identifier?: string;
  chunkType: string;
  content: string;
  startLine: number;
  endLine: number;
  jsonPointer?: string;
  stability: string;
  lifecycle: string;
}

export interface FetchKnowledgeResult {
  targetKind: FetchTargetKind;
  documentId: string;
  requestedChunkId?: string;
  title: string;
  path: string;
  kind: string;
  category: string;
  language: string;
  sourceId: string;
  sourceName: string;
  sourceTier: number;
  channel: string;
  stability: string;
  lifecycle: string;
  chunks: FetchChunk[];
  truncated: boolean;
  totalChars: number;
  repository?: string;
  revision?: string;
  canonicalUrl?: string;
  revisionUrl?: string;
  apiPackage?: string;
  apiVersion?: string;
  minecraftVersion?: string;
}

interface DocumentRow {
  id: number;
  document_id: string;
  title: string;
  path: string;
  kind: string;
  category: string;
  language: string;
  source_id: string;
  source_name: string;
  source_tier: number;
  channel: string;
  stability: string;
  lifecycle: string;
  repository: string | null;
  revision: string | null;
  canonical_url: string | null;
  revision_url: string | null;
  api_package: string | null;
  api_version: string | null;
  minecraft_version: string | null;
}

interface ChunkRow {
  chunk_id: string;
  ordinal: number;
  title: string;
  identifier: string | null;
  chunk_type: string;
  content: string;
  start_line: number;
  end_line: number;
  json_pointer: string | null;
  stability: string;
  lifecycle: string;
}

function validateBound(value: number | undefined, name: string, defaultValue: number): number {
  const resolved = value ?? defaultValue;
  if (!Number.isSafeInteger(resolved) || resolved < 0 || resolved > 3) throw new RangeError(`${name} must be an integer between 0 and 3`);
  return resolved;
}

function validateMaxChars(value: number | undefined): number {
  const resolved = value ?? 12_000;
  if (!Number.isSafeInteger(resolved) || resolved < 1_000 || resolved > 24_000) throw new RangeError("maxChars must be an integer between 1000 and 24000");
  return resolved;
}

function documentFromId(database: DatabaseSync, id: string): DocumentRow | undefined {
  return database.prepare(`
    SELECT d.id, d.document_id, d.title, d.path, d.kind, d.category, d.language,
      s.id AS source_id, s.name AS source_name, s.tier AS source_tier,
      d.channel, d.stability, d.lifecycle, d.repository, d.revision,
      d.canonical_url, d.revision_url, d.api_package, d.api_version, d.minecraft_version
    FROM documents d
    JOIN sources s ON s.id = d.source_id
    WHERE d.document_id = ?
  `).get(id) as DocumentRow | undefined;
}

function documentFromChunkId(database: DatabaseSync, id: string): (DocumentRow & { requested_ordinal: number }) | undefined {
  return database.prepare(`
    SELECT d.id, d.document_id, d.title, d.path, d.kind, d.category, d.language,
      s.id AS source_id, s.name AS source_name, s.tier AS source_tier,
      d.channel, d.stability, d.lifecycle, d.repository, d.revision,
      d.canonical_url, d.revision_url, d.api_package, d.api_version, d.minecraft_version,
      c.ordinal AS requested_ordinal
    FROM chunks c
    JOIN documents d ON d.id = c.document_id
    JOIN sources s ON s.id = d.source_id
    WHERE c.chunk_id = ?
  `).get(id) as (DocumentRow & { requested_ordinal: number }) | undefined;
}

function mapChunk(row: ChunkRow, content: string): FetchChunk {
  return {
    chunkId: row.chunk_id,
    ordinal: row.ordinal,
    title: row.title,
    ...(row.identifier ? { identifier: row.identifier } : {}),
    chunkType: row.chunk_type,
    content,
    startLine: row.start_line,
    endLine: row.end_line,
    ...(row.json_pointer ? { jsonPointer: row.json_pointer } : {}),
    stability: row.stability,
    lifecycle: row.lifecycle,
  };
}

export function fetchKnowledge(database: DatabaseSync, options: FetchKnowledgeOptions): FetchKnowledgeResult {
  const id = options.id.trim();
  const contextBefore = validateBound(options.contextBefore, "contextBefore", 1);
  const contextAfter = validateBound(options.contextAfter, "contextAfter", 1);
  const maxChars = validateMaxChars(options.maxChars);

  let targetKind: FetchTargetKind;
  let document: DocumentRow;
  let rows: ChunkRow[];

  if (CHUNK_ID.test(id)) {
    targetKind = "chunk";
    const resolved = documentFromChunkId(database, id);
    if (!resolved) throw new Error("NOT_FOUND: chunk ID does not exist");
    document = resolved;
    rows = database.prepare(`
      SELECT chunk_id, ordinal, title, identifier, chunk_type, content, start_line, end_line,
        json_pointer, stability, lifecycle
      FROM chunks
      WHERE document_id = ? AND ordinal BETWEEN ? AND ?
      ORDER BY ordinal ASC
    `).all(
      document.id,
      Math.max(0, resolved.requested_ordinal - contextBefore),
      resolved.requested_ordinal + contextAfter,
    ) as unknown as ChunkRow[];
  } else if (DOCUMENT_ID.test(id)) {
    targetKind = "document";
    const resolved = documentFromId(database, id);
    if (!resolved) throw new Error("NOT_FOUND: document ID does not exist");
    document = resolved;
    rows = database.prepare(`
      SELECT chunk_id, ordinal, title, identifier, chunk_type, content, start_line, end_line,
        json_pointer, stability, lifecycle
      FROM chunks
      WHERE document_id = ?
      ORDER BY ordinal ASC
    `).all(document.id) as unknown as ChunkRow[];
  } else {
    throw new Error("INVALID_DOCUMENT_ID: fetch accepts only server-issued doc_* or chk_* IDs");
  }

  const chunks: FetchChunk[] = [];
  let totalChars = 0;
  let truncated = false;
  for (const row of rows) {
    const remaining = maxChars - totalChars;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    let content = row.content;
    if (content.length > remaining) {
      content = `${content.slice(0, Math.max(0, remaining - 1)).trimEnd()}…`;
      truncated = true;
    }
    chunks.push(mapChunk(row, content));
    totalChars += content.length;
    if (content.length < row.content.length) break;
  }
  if (chunks.length < rows.length) truncated = true;

  return {
    targetKind,
    documentId: document.document_id,
    ...(targetKind === "chunk" ? { requestedChunkId: id } : {}),
    title: document.title,
    path: document.path,
    kind: document.kind,
    category: document.category,
    language: document.language,
    sourceId: document.source_id,
    sourceName: document.source_name,
    sourceTier: document.source_tier,
    channel: document.channel,
    stability: document.stability,
    lifecycle: document.lifecycle,
    chunks,
    truncated,
    totalChars,
    ...(document.repository ? { repository: document.repository } : {}),
    ...(document.revision ? { revision: document.revision } : {}),
    ...(document.canonical_url ? { canonicalUrl: document.canonical_url } : {}),
    ...(document.revision_url ? { revisionUrl: document.revision_url } : {}),
    ...(document.api_package ? { apiPackage: document.api_package } : {}),
    ...(document.api_version ? { apiVersion: document.api_version } : {}),
    ...(document.minecraft_version ? { minecraftVersion: document.minecraft_version } : {}),
  };
}
