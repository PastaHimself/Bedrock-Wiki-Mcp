import type { DatabaseSync } from "node:sqlite";
import type { SemanticRetriever } from "../semantic/retriever.js";
import {
  knowledgeCandidateAllowed,
  searchKnowledge,
  type KnowledgeSearchOptions,
  type KnowledgeSearchResponse,
  type KnowledgeSearchResult,
} from "./engine.js";
import { detectBedrockQueryIntent, type BedrockQueryIntent } from "./intent.js";

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
  source_type: string;
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
  return knowledgeCandidateAllowed({
    kind: row.kind,
    category: row.category,
    stability: row.stability,
    lifecycle: row.lifecycle,
    channel: row.channel,
    sourceId: row.source_id,
    sourceTier: row.source_tier,
    path: row.path,
    ...(row.api_package ? { apiPackage: row.api_package } : {}),
    ...(row.api_version ? { apiVersion: row.api_version } : {}),
    ...(row.minecraft_version ? { minecraftVersion: row.minecraft_version } : {}),
  }, options);
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
      s.source_type AS source_type,
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
    sourceType: row.source_type,
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

function semanticIntentBonus(row: SemanticCandidateRow, intent: BedrockQueryIntent): number {
  let bonus = 0;
  if (intent.module && row.api_package?.toLocaleLowerCase("en-US") === intent.module) bonus += 0.0035;
  if (intent.version && row.source_type === "npm") bonus += 0.0035;
  if (intent.preview && row.channel === "preview") bonus += 0.0025;
  if (intent.stable && row.channel === "stable") bonus += 0.0025;
  if (intent.example && ["example", "code"].includes(row.kind)) bonus += 0.0015;
  if (intent.debugging && ["schemas", "debugging"].includes(row.category)) bonus += 0.0015;
  return bonus;
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

  const intent = detectBedrockQueryIntent(options.query);
  const lexicalWeight = intent.identifierLike ? 0.9 : intent.example ? 0.62 : 0.55;
  const semanticWeight = intent.identifierLike ? 0.1 : intent.example ? 0.38 : 0.45;
  const fused = new Map<string, { result: KnowledgeSearchResult; score: number }>();

  lexical.results.forEach((result, index) => {
    fused.set(result.chunkId, {
      result,
      score: lexicalWeight / (RRF_K + index + 1) + (result.exactMatch ? 10 : 0),
    });
  });

  semanticHits.forEach((hit, index) => {
    const existing = fused.get(hit.chunkId);
    const baseSemanticScore = semanticWeight / (RRF_K + index + 1);
    if (existing) {
      existing.score += baseSemanticScore;
      return;
    }
    const row = loadSemanticCandidate(database, hit.chunkId);
    if (!row || !allowed(row, options)) return;
    fused.set(hit.chunkId, {
      result: publicSemanticResult(row),
      score: baseSemanticScore + semanticIntentBonus(row, intent),
    });
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
