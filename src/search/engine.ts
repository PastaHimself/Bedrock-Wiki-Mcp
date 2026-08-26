import type { DatabaseSync } from "node:sqlite";
import { normalizeIdentifier } from "../identifiers/normalize.js";
import type { DocumentKind } from "../models/enums.js";
import { exactIdentifierSearch, type ExactIdentifierHit } from "./exact.js";
import { lexicalSearch, type LexicalSearchHit } from "./lexical.js";

const PREVIEW_INTENT = /\b(?:preview|beta|experimental)\b/i;
const HISTORICAL_INTENT = /\b(?:historical|legacy|old\s+api|prior\s+api)\b/i;
const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "do", "does", "for", "from",
  "how", "i", "in", "is", "it", "make", "of", "on", "the", "to", "use", "when", "with",
]);
const MAX_MERGED_RAW_CHARS = 3_200;
const MIN_NEIGHBOR_SCORE = 12;

export interface KnowledgeSearchOptions {
  query: string;
  limit?: number;
  kinds?: DocumentKind[];
  categories?: string[];
  stabilities?: string[];
  sourceTiers?: number[];
  minecraftVersion?: string;
  includePreview?: boolean;
  includeHistorical?: boolean;
  maxChars?: number;
}

export interface KnowledgeSearchResult {
  chunkId: string;
  documentId: string;
  title: string;
  identifier?: string;
  excerpt: string;
  path: string;
  kind: string;
  category: string;
  stability: string;
  lifecycle: string;
  channel: string;
  sourceId: string;
  sourceName: string;
  sourceTier: number;
  score: number;
  exactMatch: boolean;
  mergedChunkIds?: string[];
  repository?: string;
  revision?: string;
  canonicalUrl?: string;
  revisionUrl?: string;
  apiPackage?: string;
  apiVersion?: string;
  minecraftVersion?: string;
}

export interface KnowledgeSearchResponse {
  query: string;
  results: KnowledgeSearchResult[];
  truncated: boolean;
  totalChars: number;
}

type Candidate = KnowledgeSearchResult & {
  rawContent: string;
  ordinal: number;
  mergedChunkIds: string[];
};

function validateOptions(options: KnowledgeSearchOptions): { limit: number; maxChars: number } {
  const limit = options.limit ?? 5;
  const maxChars = options.maxChars ?? 10_000;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) throw new RangeError("limit must be an integer between 1 and 10");
  if (!Number.isSafeInteger(maxChars) || maxChars < 2_000 || maxChars > 24_000) throw new RangeError("maxChars must be an integer between 2000 and 24000");
  if (options.query.trim().length < 1 || options.query.length > 500) throw new RangeError("query must contain 1 to 500 characters");
  if ((options.kinds?.length ?? 0) > 10) throw new RangeError("kinds may contain at most 10 values");
  if ((options.categories?.length ?? 0) > 10) throw new RangeError("categories may contain at most 10 values");
  if ((options.sourceTiers?.length ?? 0) > 4) throw new RangeError("sourceTiers may contain at most 4 values");
  for (const tier of options.sourceTiers ?? []) {
    if (!Number.isSafeInteger(tier) || tier < 1 || tier > 4) throw new RangeError("sourceTiers values must be integers from 1 to 4");
  }
  return { limit, maxChars };
}

function metadataBonus(candidate: Pick<Candidate, "sourceTier" | "stability" | "lifecycle" | "channel">): number {
  let score = (5 - candidate.sourceTier) * 0.75;
  score += candidate.lifecycle === "active" ? 3 : candidate.lifecycle === "deprecated" ? -2 : candidate.lifecycle === "historical" ? -5 : 0;
  score += candidate.stability === "stable" ? 3 : candidate.stability === "beta" ? 1 : candidate.stability === "experimental" ? -2 : candidate.stability === "internal" ? -4 : 0;
  score += candidate.channel === "stable" ? 2 : candidate.channel === "preview" ? -2 : 0;
  return score;
}

function fromExact(hit: ExactIdentifierHit, rank: number): Candidate {
  const candidate: Candidate = {
    chunkId: hit.chunkId,
    documentId: hit.documentId,
    ordinal: hit.ordinal,
    identifier: hit.identifier,
    excerpt: "",
    rawContent: hit.content,
    mergedChunkIds: [],
    title: hit.title,
    path: hit.path,
    kind: hit.kind,
    category: hit.category,
    stability: hit.stability,
    lifecycle: hit.lifecycle,
    channel: hit.channel,
    sourceId: hit.sourceId,
    sourceName: hit.sourceName,
    sourceTier: hit.sourceTier,
    score: 1000 - rank * 5 + (hit.isPrimary ? 2 : 0),
    exactMatch: true,
    ...(hit.repository ? { repository: hit.repository } : {}),
    ...(hit.revision ? { revision: hit.revision } : {}),
    ...(hit.canonicalUrl ? { canonicalUrl: hit.canonicalUrl } : {}),
    ...(hit.revisionUrl ? { revisionUrl: hit.revisionUrl } : {}),
    ...(hit.apiPackage ? { apiPackage: hit.apiPackage } : {}),
    ...(hit.apiVersion ? { apiVersion: hit.apiVersion } : {}),
    ...(hit.minecraftVersion ? { minecraftVersion: hit.minecraftVersion } : {}),
  };
  candidate.score += metadataBonus(candidate);
  return candidate;
}

function fromLexical(hit: LexicalSearchHit, rank: number): Candidate {
  const candidate: Candidate = {
    chunkId: hit.chunkId,
    documentId: hit.documentId,
    ordinal: hit.ordinal,
    ...(hit.identifier ? { identifier: hit.identifier } : {}),
    excerpt: "",
    rawContent: hit.content,
    mergedChunkIds: [],
    title: hit.title,
    path: hit.path,
    kind: hit.kind,
    category: hit.category,
    stability: hit.stability,
    lifecycle: hit.lifecycle,
    channel: hit.channel,
    sourceId: hit.sourceId,
    sourceName: hit.sourceName,
    sourceTier: hit.sourceTier,
    score: 100 / (rank + 1),
    exactMatch: false,
    ...(hit.repository ? { repository: hit.repository } : {}),
    ...(hit.revision ? { revision: hit.revision } : {}),
    ...(hit.canonicalUrl ? { canonicalUrl: hit.canonicalUrl } : {}),
    ...(hit.revisionUrl ? { revisionUrl: hit.revisionUrl } : {}),
    ...(hit.apiPackage ? { apiPackage: hit.apiPackage } : {}),
    ...(hit.apiVersion ? { apiVersion: hit.apiVersion } : {}),
    ...(hit.minecraftVersion ? { minecraftVersion: hit.minecraftVersion } : {}),
  };
  candidate.score += metadataBonus(candidate);
  return candidate;
}

function candidateAllowed(candidate: Candidate, options: KnowledgeSearchOptions, includePreview: boolean, includeHistorical: boolean): boolean {
  if (!includePreview && (candidate.channel === "preview" || ["beta", "experimental", "internal"].includes(candidate.stability))) return false;
  if (!includeHistorical && ["historical", "removed"].includes(candidate.lifecycle)) return false;
  if (options.kinds?.length && !options.kinds.includes(candidate.kind as DocumentKind)) return false;
  if (options.categories?.length && !options.categories.includes(candidate.category)) return false;
  if (options.stabilities?.length && !options.stabilities.includes(candidate.stability)) return false;
  const tiers = options.sourceTiers ?? [1, 2, 3];
  if (!tiers.includes(candidate.sourceTier)) return false;
  if (options.minecraftVersion && candidate.minecraftVersion && candidate.minecraftVersion !== options.minecraftVersion) return false;
  return true;
}

function meaningfulQueryTerms(query: string): string[] {
  const raw = query.toLocaleLowerCase().match(/[\p{L}\p{N}_@.$:-]+/gu) ?? [];
  return [...new Set(raw.filter((term) => term.length > 1 && !STOP_WORDS.has(term)))].slice(0, 6);
}

function fallbackLexicalSearch(database: DatabaseSync, query: string): LexicalSearchHit[] {
  const accumulated = new Map<string, { hit: LexicalSearchHit; score: number }>();
  for (const term of meaningfulQueryTerms(query)) {
    for (const [rank, hit] of lexicalSearch(database, term, 15).entries()) {
      const existing = accumulated.get(hit.chunkId);
      if (existing) {
        existing.score += 1 / (rank + 1);
      } else {
        accumulated.set(hit.chunkId, { hit, score: 1 / (rank + 1) });
      }
    }
  }
  return [...accumulated.values()]
    .sort((a, b) => b.score - a.score || a.hit.bm25Rank - b.hit.bm25Rank)
    .map((entry) => entry.hit)
    .slice(0, 50);
}

function excerptFor(content: string, query: string, maxLength = 1_600): string {
  if (content.length <= maxLength) return content;
  const queryTerms = query.toLocaleLowerCase().match(/[\p{L}\p{N}_@.$:-]+/gu) ?? [];
  const lower = content.toLocaleLowerCase();
  let index = -1;
  for (const term of queryTerms) {
    const found = lower.indexOf(term.toLocaleLowerCase());
    if (found >= 0 && (index < 0 || found < index)) index = found;
  }
  if (index < 0) return `${content.slice(0, maxLength - 1).trimEnd()}…`;
  const before = Math.floor(maxLength * 0.3);
  let start = Math.max(0, index - before);
  const end = Math.min(content.length, start + maxLength);
  if (end === content.length) start = Math.max(0, end - maxLength);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < content.length ? "…" : "";
  return `${prefix}${content.slice(start, end).trim()}${suffix}`;
}

function mergeAdjacentCandidates(candidates: Candidate[]): Candidate[] {
  const byDocumentOrdinal = new Map<string, Map<number, Candidate>>();
  for (const candidate of candidates) {
    let byOrdinal = byDocumentOrdinal.get(candidate.documentId);
    if (!byOrdinal) {
      byOrdinal = new Map<number, Candidate>();
      byDocumentOrdinal.set(candidate.documentId, byOrdinal);
    }
    byOrdinal.set(candidate.ordinal, candidate);
  }

  const consumed = new Set<string>();
  const merged: Candidate[] = [];

  for (const candidate of candidates) {
    if (consumed.has(candidate.chunkId)) continue;

    const byOrdinal = byDocumentOrdinal.get(candidate.documentId);
    const neighbors = [-1, 1]
      .map((offset) => byOrdinal?.get(candidate.ordinal + offset))
      .filter((neighbor): neighbor is Candidate => Boolean(neighbor))
      .filter((neighbor) => !consumed.has(neighbor.chunkId))
      .filter((neighbor) => neighbor.score >= MIN_NEIGHBOR_SCORE || candidate.exactMatch || neighbor.exactMatch);

    const selected: Candidate[] = [candidate];
    let rawChars = candidate.rawContent.length;
    for (const neighbor of neighbors.sort((a, b) => b.score - a.score)) {
      const projected = rawChars + 2 + neighbor.rawContent.length;
      if (projected > MAX_MERGED_RAW_CHARS) continue;
      selected.push(neighbor);
      rawChars = projected;
    }

    if (selected.length === 1) {
      merged.push(candidate);
      consumed.add(candidate.chunkId);
      continue;
    }

    selected.sort((a, b) => a.ordinal - b.ordinal);
    const neighborIds = selected.filter((item) => item.chunkId !== candidate.chunkId).map((item) => item.chunkId);
    const neighborScore = selected
      .filter((item) => item.chunkId !== candidate.chunkId)
      .reduce((sum, item) => sum + item.score, 0);

    merged.push({
      ...candidate,
      rawContent: selected.map((item) => item.rawContent).join("\n\n"),
      mergedChunkIds: neighborIds,
      score: candidate.score + neighborScore * 0.1,
    });
    for (const item of selected) consumed.add(item.chunkId);
  }

  return merged;
}

function publicResult(candidate: Candidate, excerpt: string): KnowledgeSearchResult {
  return {
    chunkId: candidate.chunkId,
    documentId: candidate.documentId,
    title: candidate.title,
    ...(candidate.identifier ? { identifier: candidate.identifier } : {}),
    excerpt,
    path: candidate.path,
    kind: candidate.kind,
    category: candidate.category,
    stability: candidate.stability,
    lifecycle: candidate.lifecycle,
    channel: candidate.channel,
    sourceId: candidate.sourceId,
    sourceName: candidate.sourceName,
    sourceTier: candidate.sourceTier,
    score: Number(candidate.score.toFixed(3)),
    exactMatch: candidate.exactMatch,
    ...(candidate.mergedChunkIds.length > 0 ? { mergedChunkIds: candidate.mergedChunkIds } : {}),
    ...(candidate.repository ? { repository: candidate.repository } : {}),
    ...(candidate.revision ? { revision: candidate.revision } : {}),
    ...(candidate.canonicalUrl ? { canonicalUrl: candidate.canonicalUrl } : {}),
    ...(candidate.revisionUrl ? { revisionUrl: candidate.revisionUrl } : {}),
    ...(candidate.apiPackage ? { apiPackage: candidate.apiPackage } : {}),
    ...(candidate.apiVersion ? { apiVersion: candidate.apiVersion } : {}),
    ...(candidate.minecraftVersion ? { minecraftVersion: candidate.minecraftVersion } : {}),
  };
}

export function searchKnowledge(database: DatabaseSync, options: KnowledgeSearchOptions): KnowledgeSearchResponse {
  const validated = validateOptions(options);
  const query = options.query.trim();
  const includePreview = options.includePreview ?? PREVIEW_INTENT.test(query);
  const includeHistorical = options.includeHistorical ?? HISTORICAL_INTENT.test(query);
  const candidates = new Map<string, Candidate>();

  for (const [rank, hit] of exactIdentifierSearch(database, query, 30).entries()) {
    const candidate = fromExact(hit, rank);
    candidates.set(candidate.chunkId, candidate);
  }

  let lexicalHits: LexicalSearchHit[] = [];
  try {
    lexicalHits = lexicalSearch(database, query, 50);
    if (lexicalHits.length === 0 && meaningfulQueryTerms(query).length > 1) {
      lexicalHits = fallbackLexicalSearch(database, query);
    }
  } catch (error) {
    if (candidates.size === 0) throw error;
  }

  for (const [rank, hit] of lexicalHits.entries()) {
    const existing = candidates.get(hit.chunkId);
    if (existing) {
      existing.score += 50 / (rank + 1);
      continue;
    }
    candidates.set(hit.chunkId, fromLexical(hit, rank));
  }

  const normalizedQuery = normalizeIdentifier(query);
  const filtered = [...candidates.values()]
    .filter((candidate) => candidateAllowed(candidate, options, includePreview, includeHistorical))
    .map((candidate) => {
      if (candidate.identifier && normalizeIdentifier(candidate.identifier) === normalizedQuery) candidate.score += 20;
      return candidate;
    })
    .sort((a, b) => b.score - a.score || a.sourceTier - b.sourceTier || a.chunkId.localeCompare(b.chunkId));
  const ranked = mergeAdjacentCandidates(filtered);

  const perDocument = new Map<string, number>();
  const results: KnowledgeSearchResult[] = [];
  let totalChars = 0;
  let truncated = false;

  for (const candidate of ranked) {
    if (results.length >= validated.limit) {
      truncated = true;
      break;
    }
    const usedFromDocument = perDocument.get(candidate.documentId) ?? 0;
    if (usedFromDocument >= 2 && !candidate.exactMatch) continue;

    const remaining = validated.maxChars - totalChars;
    if (remaining < 200) {
      truncated = true;
      break;
    }
    const perResultLimit = candidate.mergedChunkIds.length > 0 ? 2_400 : 1_600;
    const excerpt = excerptFor(candidate.rawContent, query, Math.min(perResultLimit, remaining));
    results.push(publicResult(candidate, excerpt));
    totalChars += excerpt.length;
    perDocument.set(candidate.documentId, usedFromDocument + 1);
  }

  if (ranked.length > results.length) truncated = true;
  return { query, results, truncated, totalChars };
}
