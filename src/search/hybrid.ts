import type { DatabaseSync } from "node:sqlite";
import type { DocumentKind } from "../models/enums.js";
import type { SemanticRetriever } from "../semantic/retriever.js";
import { searchKnowledge, type KnowledgeSearchOptions, type KnowledgeSearchResponse, type KnowledgeSearchResult } from "./engine.js";
import { versionCompatibility } from "./version.js";

const IDENTIFIER_LIKE = /(?:minecraft:|@minecraft\/|[._][A-Za-z_$]|[A-Z][a-z]+[A-Z]|\b[A-Za-z_$]+\.[A-Za-z_$]+)/;
const PREVIEW_INTENT = /\b(?:preview|beta|experimental)\b/i;
const HISTORICAL_INTENT = /\b(?:historical|legacy|old\s+api|prior\s+api)\b/i;
const RRF_K = 60;

interface SemanticCandidateRow {
  chunk_id: string;
  document_id: string;
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
  source_tier: number;
  repository: string | null;
  revision: string | null;
  canonical_url: string | null;
  revision_url: string | null;
  api_package: string | null;
  api_version: string | null;
  minecraft_version: string | null;
}

function allowed(row: SemanticCandidateRow, options: KnowledgeSearchOptions): boolean {
  const includePreview = options.includePreview ?? PREVIEW_INTENT.test(options.query);
  const includeHistorical = options.includeHistorical ?? HISTORICAL_INTENT.test(options.query);
  if (!includePreview && (row.channel === "preview" || ["beta", "experimental", "internal"].includes(row.stability))) return false;
  if (!includeHistorical && ["historical", "removed"].includes(row.lifecycle)) return false;
  if (options.kinds?.length && !options.kinds.includes(row.kind as DocumentKind)) return false;
  if (options.categories?.length && !options.categories.includes(row.category)) return false;
  if (options.stabilities?.length && !options.stabilities.includes(row.stability)) return false;
  if (!(options.sourceTiers ?? [1, 2, 3]).includes(row.source_tier)) return false;
  if (versionCompatibility(options.minecraftVersion, row.minecraft_version ?? undefined) === "mismatch") return false;
  if (versionCompatibility(options.apiVersion, row.api_version ?? undefined) === "mismatch") return false;
  return true;
}

function excerpt(content: string, maxChars = 1_600): string {
  return content.length <= maxChars ? content : `${content.slice(0, maxChars - 1).trimEnd()}…`;
}

function loadSemanticCandidate(database: DatabaseSync, chunkId: string): SemanticCandidateRow | undefined {
  return database.prepare(`
    SELECT
      c.chunk_id,
      d.document_id,
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
      s.tier AS source_tier,
      d.repository,
      d.revision,
      d.canonical_url,
      d.revision_url,
      d.api_package,
      d.api_version,
      d.minecraft_version
    FROM chunks c
    JOIN documents d ON d.id = c.document_id
    JOIN sources s ON s.id = d.source_id
    WHERE c.chunk_id = ?
  `).get(chunkId) as SemanticCandidateRow | undefined;
}

function publicSemanticResult(row: SemanticCandidateRow): KnowledgeSearchResult {
  return {
    chunkId: row.chunk_id,
    documentId: row.document_id,
    title: row.title,
    ...(row.identifier ? { identifier: row.identifier } : {}),
    excerpt: excerpt(row.content),
    path: row.path,
    kind: row.kind,
    category: row.category,
    stability: row.stability,
    lifecycle: row.lifecycle,
    channel: row.channel,
    sourceId: row.source_id,
    sourceName: row.source_name,
    sourceTier: row.source_tier,
    score: 0,
    exactMatch: false,
    ...(row.repository ? { repository: row.repository } : {}),
    ...(row.revision ? { revision: row.revision } : {}),
    ...(row.canonical_url ? { canonicalUrl: row.canonical_url } : {}),
    ...(row.revision_url ? { revisionUrl: row.revision_url } : {}),
    ...(row.api_package ? { apiPackage: row.api_package } : {}),
    ...(row.api_version ? { apiVersion: row.api_version } : {}),
    ...(row.minecraft_version ? { minecraftVersion: row.minecraft_version } : {}),
  };
}

export async function hybridSearchKnowledge(
  database: DatabaseSync,
  semantic: SemanticRetriever,
  options: KnowledgeSearchOptions,
  semanticTopK = 40,
): Promise<KnowledgeSearchResponse> {
  const requestedLimit = options.limit ?? 5;
  const maxChars = options.maxChars ?? 10_000;
  const lexical = searchKnowledge(database, { ...options, limit: 10, maxChars: 24_000 });
  let semanticHits;
  try {
    semanticHits = await semantic.search(options.query, semanticTopK);
  } catch {
    return searchKnowledge(database, options);
  }

  const identifierLike = IDENTIFIER_LIKE.test(options.query);
  const lexicalWeight = identifierLike ? 0.9 : 0.55;
  const semanticWeight = identifierLike ? 0.1 : 0.45;
  const fused = new Map<string, { result: KnowledgeSearchResult; score: number }>();

  lexical.results.forEach((result, index) => {
    fused.set(result.chunkId, {
      result,
      score: lexicalWeight / (RRF_K + index + 1) + (result.exactMatch ? 10 : 0),
    });
  });

  semanticHits.forEach((hit, index) => {
    const existing = fused.get(hit.chunkId);
    const semanticScore = semanticWeight / (RRF_K + index + 1);
    if (existing) {
      existing.score += semanticScore;
      return;
    }
    const row = loadSemanticCandidate(database, hit.chunkId);
    if (!row || !allowed(row, options)) return;
    fused.set(hit.chunkId, { result: publicSemanticResult(row), score: semanticScore });
  });

  const ranked = [...fused.values()]
    .sort((a, b) => Number(b.result.exactMatch) - Number(a.result.exactMatch) || b.score - a.score || a.result.sourceTier - b.result.sourceTier);

  const results: KnowledgeSearchResult[] = [];
  const perDocument = new Map<string, number>();
  let totalChars = 0;
  let truncated = false;
  for (const entry of ranked) {
    if (results.length >= requestedLimit) {
      truncated = true;
      break;
    }
    const used = perDocument.get(entry.result.documentId) ?? 0;
    if (used >= 2 && !entry.result.exactMatch) continue;
    const remaining = maxChars - totalChars;
    if (remaining < 200) {
      truncated = true;
      break;
    }
    const boundedExcerpt = entry.result.excerpt.length <= remaining
      ? entry.result.excerpt
      : `${entry.result.excerpt.slice(0, Math.max(1, remaining - 1)).trimEnd()}…`;
    results.push({
      ...entry.result,
      excerpt: boundedExcerpt,
      score: entry.result.exactMatch ? entry.result.score : Number((entry.score * 100_000).toFixed(3)),
    });
    totalChars += boundedExcerpt.length;
    perDocument.set(entry.result.documentId, used + 1);
  }
  if (ranked.length > results.length) truncated = true;
  return { query: options.query.trim(), results, truncated, totalChars };
}
