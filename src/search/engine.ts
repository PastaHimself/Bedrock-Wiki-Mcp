import type { DatabaseSync } from "node:sqlite";
import type { DocumentKind } from "../models/enums.js";
import { normalizeIdentifier } from "../identifiers/normalize.js";
import { exactIdentifierSearch, type ExactIdentifierHit } from "./exact.js";
import { lexicalSearch, type LexicalSearchHit } from "./lexical.js";

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

type Candidate = KnowledgeSearchResult & { rawContent: string };

function validateOptions(options: KnowledgeSearchOptions): Required<Pick<KnowledgeSearchOptions, "limit" | "includePreview" | "includeHistorical" | "maxChars">> {
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
  return {
    limit,
    maxChars,
    includePreview: options.includePreview ?? false,
    includeHistorical: options.includeHistorical ?? false,
  };
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
    title: hit.title,
    identifier: hit.identifier,
    excerpt: "",
    rawContent: hit.content,
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
    title: hit.title,
    ...(hit.identifier ? { identifier: hit.identifier } : {}),
    excerpt: "",
    rawContent: hit.content,
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
  let end = Math.min(content.length, start + maxLength);
  if (end === content.length) start = Math.max(0, end - maxLength);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < content.length ? "…" : "";
  return `${prefix}${content.slice(start, end).trim()}${suffix}`;
}

export function searchKnowledge(database: DatabaseSync, options: KnowledgeSearchOptions): KnowledgeSearchResponse {
  const validated = validateOptions(options);
  const query = options.query.trim();
  const candidates = new Map<string, Candidate>();

  for (const [rank, hit] of exactIdentifierSearch(database, query, 30).entries()) {
    const candidate = fromExact(hit, rank);
    candidates.set(candidate.chunkId, candidate);
  }

  let lexicalHits: LexicalSearchHit[] = [];
  try {
    lexicalHits = lexicalSearch(database, query, 50);
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
    .filter((candidate) => candidateAllowed(candidate, options, validated.includePreview, validated.includeHistorical))
    .map((candidate) => {
      if (candidate.identifier && normalizeIdentifier(candidate.identifier) === normalizedQuery) candidate.score += 20;
      return candidate;
    })
    .sort((a, b) => b.score - a.score || a.sourceTier - b.sourceTier || a.chunkId.localeCompare(b.chunkId));

  const perDocument = new Map<string, number>();
  const results: KnowledgeSearchResult[] = [];
  let totalChars = 0;
  let truncated = false;

  for (const candidate of filtered) {
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
    const excerpt = excerptFor(candidate.rawContent, query, Math.min(1_600, remaining));
    const { rawContent: _rawContent, ...result } = candidate;
    results.push({ ...result, excerpt, score: Number(result.score.toFixed(3)) });
    totalChars += excerpt.length;
    perDocument.set(candidate.documentId, usedFromDocument + 1);
  }

  if (filtered.length > results.length) truncated = true;
  return { query, results, truncated, totalChars };
}
