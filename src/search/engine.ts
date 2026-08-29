import type { DatabaseSync } from "node:sqlite";
import { normalizeIdentifier } from "../identifiers/normalize.js";
import type { DocumentKind } from "../models/enums.js";
import { isNearDuplicateEvidence } from "./dedup.js";
import { exactIdentifierSearch, type ExactIdentifierHit } from "./exact.js";
import { detectBedrockQueryIntent, type BedrockQueryIntent } from "./intent.js";
import { lexicalSearch, type LexicalSearchHit } from "./lexical.js";
import { versionCompatibility, versionMatchScore } from "./version.js";

const HISTORICAL_INTENT = /\b(?:historical|legacy|old\s+api|prior\s+api)\b/i;
const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "current", "do", "does", "for", "from",
  "how", "i", "in", "is", "it", "latest", "make", "of", "on", "the", "to", "use", "version", "when", "with",
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
  sourceId?: string;
  channel?: string;
  apiPackage?: string;
  pathPrefix?: string;
  minecraftVersion?: string;
  apiVersion?: string;
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
  sourceType: string;
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

export interface KnowledgeFilterCandidate {
  kind: string;
  category: string;
  stability: string;
  lifecycle: string;
  channel: string;
  sourceId: string;
  sourceTier: number;
  path: string;
  apiPackage?: string;
  apiVersion?: string;
  minecraftVersion?: string;
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
  if ((options.stabilities?.length ?? 0) > 5) throw new RangeError("stabilities may contain at most 5 values");
  if ((options.sourceTiers?.length ?? 0) > 4) throw new RangeError("sourceTiers may contain at most 4 values");
  if ((options.sourceId?.length ?? 0) > 100) throw new RangeError("sourceId may contain at most 100 characters");
  if ((options.channel?.length ?? 0) > 20) throw new RangeError("channel may contain at most 20 characters");
  if ((options.apiPackage?.length ?? 0) > 100) throw new RangeError("apiPackage may contain at most 100 characters");
  if ((options.pathPrefix?.length ?? 0) > 500) throw new RangeError("pathPrefix may contain at most 500 characters");
  if ((options.minecraftVersion?.length ?? 0) > 50) throw new RangeError("minecraftVersion may contain at most 50 characters");
  if ((options.apiVersion?.length ?? 0) > 50) throw new RangeError("apiVersion may contain at most 50 characters");
  for (const tier of options.sourceTiers ?? []) {
    if (!Number.isSafeInteger(tier) || tier < 1 || tier > 4) throw new RangeError("sourceTiers values must be integers from 1 to 4");
  }
  return { limit, maxChars };
}

export function includePreviewForSearch(options: KnowledgeSearchOptions): boolean {
  const intent = detectBedrockQueryIntent(options.query);
  return options.includePreview ?? (intent.preview || options.channel?.toLocaleLowerCase("en-US") === "preview");
}

export function knowledgeCandidateAllowed(candidate: KnowledgeFilterCandidate, options: KnowledgeSearchOptions): boolean {
  const includePreview = includePreviewForSearch(options);
  const includeHistorical = options.includeHistorical ?? HISTORICAL_INTENT.test(options.query);
  if (!includePreview && (candidate.channel === "preview" || ["beta", "experimental", "internal"].includes(candidate.stability))) return false;
  if (!includeHistorical && ["historical", "removed"].includes(candidate.lifecycle)) return false;
  if (options.kinds?.length && !options.kinds.includes(candidate.kind as DocumentKind)) return false;
  if (options.categories?.length && !options.categories.includes(candidate.category)) return false;
  if (options.stabilities?.length && !options.stabilities.includes(candidate.stability)) return false;
  const tiers = options.sourceTiers ?? [1, 2, 3];
  if (!tiers.includes(candidate.sourceTier)) return false;
  if (options.sourceId && candidate.sourceId !== options.sourceId) return false;
  if (options.channel && candidate.channel.toLocaleLowerCase("en-US") !== options.channel.toLocaleLowerCase("en-US")) return false;
  if (options.apiPackage && candidate.apiPackage?.toLocaleLowerCase("en-US") !== options.apiPackage.toLocaleLowerCase("en-US")) return false;
  if (options.pathPrefix && !candidate.path.toLocaleLowerCase("en-US").startsWith(options.pathPrefix.replace(/^\/+/, "").toLocaleLowerCase("en-US"))) return false;
  if (versionCompatibility(options.minecraftVersion, candidate.minecraftVersion) === "mismatch") return false;
  if (versionCompatibility(options.apiVersion, candidate.apiVersion) === "mismatch") return false;
  return true;
}

function metadataBonus(candidate: Pick<Candidate, "sourceTier" | "stability" | "lifecycle" | "channel">): number {
  let score = (5 - candidate.sourceTier) * 2.5;
  score += candidate.lifecycle === "active" ? 4 : candidate.lifecycle === "deprecated" ? -4 : candidate.lifecycle === "historical" ? -8 : 0;
  score += candidate.stability === "stable" ? 4 : candidate.stability === "beta" ? 1 : candidate.stability === "experimental" ? -2 : candidate.stability === "internal" ? -5 : 0;
  score += candidate.channel === "stable" ? 3 : candidate.channel === "preview" ? -2 : 0;
  return score;
}

function requestedVersionBonus(candidate: Candidate, options: KnowledgeSearchOptions): number {
  return versionMatchScore(options.minecraftVersion, candidate.minecraftVersion)
    + versionMatchScore(options.apiVersion, candidate.apiVersion);
}

function meaningfulQueryTerms(query: string): string[] {
  const raw = query.toLocaleLowerCase("en-US").match(/[\p{L}\p{N}_@.$:-]+/gu) ?? [];
  return [...new Set(raw.filter((term) => term.length > 1 && !STOP_WORDS.has(term)))].slice(0, 8);
}

function intentBonus(candidate: Candidate, intent: BedrockQueryIntent, terms: readonly string[]): number {
  let score = 0;
  const packageName = candidate.apiPackage?.toLocaleLowerCase("en-US");
  const lowerTitle = candidate.title.toLocaleLowerCase("en-US");
  const lowerPath = candidate.path.toLocaleLowerCase("en-US");

  if (intent.module && packageName === intent.module) score += 40;
  if (intent.version) {
    if (candidate.sourceType === "npm") score += 28;
    if (candidate.apiVersion) score += 8;
  }
  if (intent.manifest) {
    if (candidate.category === "manifests") score += 18;
    if (lowerPath.includes("manifest") || lowerTitle.includes("manifest")) score += 12;
    if (candidate.sourceType === "npm" && candidate.channel === "stable") score += 8;
  }
  if (intent.example) {
    if (candidate.kind === "example") score += 18;
    else if (candidate.kind === "code") score += 10;
    if (/(?:^|\/)(?:samples?|examples?)(?:\/|$)/i.test(candidate.path)) score += 12;
  }
  if (intent.definition && ["api", "component", "reference"].includes(candidate.kind)) score += 10;
  if (intent.debugging) {
    if (["schemas", "debugging"].includes(candidate.category)) score += 16;
    if (/schema|debug/i.test(candidate.path)) score += 8;
  }
  if (intent.preview) {
    if (candidate.channel === "preview") score += 18;
    if (["beta", "experimental"].includes(candidate.stability)) score += 8;
  } else if (intent.stable) {
    if (candidate.channel === "stable") score += 18;
    if (candidate.stability === "stable") score += 8;
    if (candidate.channel === "preview") score -= 16;
  }

  for (const term of terms) {
    if (lowerTitle.includes(term)) score += 2.5;
    if (lowerPath.includes(term)) score += 0.75;
  }
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
    sourceType: hit.sourceType,
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
    sourceType: hit.sourceType,
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

function fallbackLexicalSearch(database: DatabaseSync, query: string, wide = false): LexicalSearchHit[] {
  const accumulated = new Map<string, { hit: LexicalSearchHit; score: number }>();
  for (const term of meaningfulQueryTerms(query)) {
    for (const [rank, hit] of lexicalSearch(database, term, wide ? 30 : 15).entries()) {
      const existing = accumulated.get(hit.chunkId);
      if (existing) existing.score += 1 / (rank + 1);
      else accumulated.set(hit.chunkId, { hit, score: 1 / (rank + 1) });
    }
  }
  return [...accumulated.values()]
    .sort((a, b) => b.score - a.score || a.hit.bm25Rank - b.hit.bm25Rank)
    .map((entry) => entry.hit)
    .slice(0, wide ? 100 : 50);
}

function excerptFor(content: string, query: string, maxLength = 1_600): string {
  if (content.length <= maxLength) return content;
  const queryTerms = query.toLocaleLowerCase("en-US").match(/[\p{L}\p{N}_@.$:-]+/gu) ?? [];
  const lower = content.toLocaleLowerCase("en-US");
  let index = -1;
  for (const term of queryTerms) {
    const found = lower.indexOf(term.toLocaleLowerCase("en-US"));
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
    const neighborScore = selected.filter((item) => item.chunkId !== candidate.chunkId).reduce((sum, item) => sum + item.score, 0);
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
    sourceType: candidate.sourceType,
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

function duplicateOfAccepted(candidate: Candidate, accepted: readonly Candidate[]): boolean {
  return accepted.some((existing) => isNearDuplicateEvidence({
    text: candidate.rawContent,
    ...(candidate.identifier ? { identifier: candidate.identifier } : {}),
    ...(candidate.apiVersion ? { apiVersion: candidate.apiVersion } : {}),
    ...(candidate.minecraftVersion ? { minecraftVersion: candidate.minecraftVersion } : {}),
    channel: candidate.channel,
  }, {
    text: existing.rawContent,
    ...(existing.identifier ? { identifier: existing.identifier } : {}),
    ...(existing.apiVersion ? { apiVersion: existing.apiVersion } : {}),
    ...(existing.minecraftVersion ? { minecraftVersion: existing.minecraftVersion } : {}),
    channel: existing.channel,
  }));
}

export function searchKnowledge(database: DatabaseSync, options: KnowledgeSearchOptions): KnowledgeSearchResponse {
  const validated = validateOptions(options);
  const query = options.query.trim();
  const intent = detectBedrockQueryIntent(query);
  const candidates = new Map<string, Candidate>();
  const narrowFilter = Boolean(options.sourceId || options.channel || options.apiPackage || options.pathPrefix);

  for (const [rank, hit] of exactIdentifierSearch(database, query, narrowFilter ? 50 : 30).entries()) {
    const candidate = fromExact(hit, rank);
    candidates.set(candidate.chunkId, candidate);
  }

  let lexicalHits: LexicalSearchHit[] = [];
  try {
    lexicalHits = lexicalSearch(database, query, narrowFilter ? 100 : 50);
    if (lexicalHits.length === 0 && meaningfulQueryTerms(query).length > 1) lexicalHits = fallbackLexicalSearch(database, query, narrowFilter);
  } catch (error) {
    if (candidates.size === 0 && meaningfulQueryTerms(query).length > 0) {
      lexicalHits = fallbackLexicalSearch(database, query, narrowFilter);
      if (lexicalHits.length === 0) throw error;
    }
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
  const terms = meaningfulQueryTerms(query);
  const filtered = [...candidates.values()]
    .filter((candidate) => knowledgeCandidateAllowed(candidate, options))
    .map((candidate) => {
      if (candidate.identifier && normalizeIdentifier(candidate.identifier) === normalizedQuery) candidate.score += 20;
      candidate.score += requestedVersionBonus(candidate, options);
      candidate.score += intentBonus(candidate, intent, terms);
      return candidate;
    })
    .sort((a, b) => b.score - a.score || a.sourceTier - b.sourceTier || a.chunkId.localeCompare(b.chunkId));
  const ranked = mergeAdjacentCandidates(filtered);

  const perDocument = new Map<string, number>();
  const results: KnowledgeSearchResult[] = [];
  const acceptedEvidence: Candidate[] = [];
  let totalChars = 0;
  let truncated = false;

  for (const candidate of ranked) {
    if (results.length >= validated.limit) {
      truncated = true;
      break;
    }
    const usedFromDocument = perDocument.get(candidate.documentId) ?? 0;
    if (usedFromDocument >= 2 && !candidate.exactMatch) continue;
    if (duplicateOfAccepted(candidate, acceptedEvidence)) {
      truncated = true;
      continue;
    }

    const remaining = validated.maxChars - totalChars;
    if (remaining < 200) {
      truncated = true;
      break;
    }
    const perResultLimit = candidate.mergedChunkIds.length > 0 ? 2_400 : 1_600;
    const excerpt = excerptFor(candidate.rawContent, query, Math.min(perResultLimit, remaining));
    results.push(publicResult(candidate, excerpt));
    acceptedEvidence.push(candidate);
    totalChars += excerpt.length;
    perDocument.set(candidate.documentId, usedFromDocument + 1);
  }

  if (ranked.length > results.length) truncated = true;
  return { query, results, truncated, totalChars };
}
