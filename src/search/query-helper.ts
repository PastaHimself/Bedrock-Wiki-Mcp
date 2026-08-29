import type { DocumentKind } from "../models/enums.js";
import { detectBedrockQueryIntent } from "./intent.js";

const FETCH_ID = /\b(?:doc|chk)_[A-Za-z0-9_-]{4,64}\b/;
const NAMESPACED = /\bminecraft:[a-z0-9_.:-]+\b/gi;
const MODULE_QUALIFIED = /@minecraft\/[a-z0-9._-]+(?:\.[A-Za-z_$][\w$]*)*/gi;
const DOTTED = /\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+\b/g;
const PASCAL = /\b[A-Z][A-Za-z0-9_$]{2,}\b/g;
const QUOTED = /[`'"]([^`'"\n]{2,120})[`'"]/g;
const SOURCE_DISCOVERY = /\b(?:which|what|list|show)\s+(?:knowledge\s+)?sources?\b|\bprovenance\b|\brepositor(?:y|ies)\b/i;
const CATEGORY_DISCOVERY = /\b(?:which|what|list|show)\s+(?:knowledge\s+)?categor(?:y|ies)\b/i;

const STOP_WORDS = new Set([
  "a", "about", "an", "and", "are", "as", "at", "be", "bedrock", "by", "can", "code", "current",
  "do", "does", "example", "find", "for", "from", "get", "how", "i", "in", "is", "it", "latest",
  "make", "minecraft", "of", "on", "please", "search", "show", "stable", "tell", "the", "to", "use",
  "version", "what", "when", "where", "which", "why", "with",
]);

const GENERIC_PASCAL = new Set([
  "API", "Bedrock", "Code", "Definition", "Example", "How", "JSON", "Minecraft", "Preview", "Script",
  "Stable", "What", "When", "Where", "Which", "Why",
]);

export type BedrockLookupTool = "search" | "get_definition" | "fetch" | "list_sources" | "list_categories";
export type BedrockLookupIntent =
  | "definition"
  | "example"
  | "debugging"
  | "version"
  | "manifest"
  | "source_discovery"
  | "category_discovery"
  | "evidence_fetch"
  | "general";

export interface BedrockQueryPlan {
  originalQuery: string;
  normalizedQuery: string;
  searchQuery: string;
  intent: BedrockLookupIntent;
  recommendedTool: BedrockLookupTool;
  confidence: number;
  identifiers: string[];
  keywords: string[];
  suggestedKinds: DocumentKind[];
  reasons: string[];
  module?: string;
  fetchId?: string;
  includePreview?: boolean;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function normalizeQuery(query: string): string {
  return query.trim().replace(/\s+/g, " ");
}

function cleanCandidate(value: string): string {
  return value
    .trim()
    .replace(/^[([<{]+/, "")
    .replace(/[\])>},;:!?]+$/, "")
    .replace(/\(\)$/, "");
}

export function extractBedrockIdentifiers(query: string): string[] {
  const candidates = [
    ...(query.match(NAMESPACED) ?? []),
    ...(query.match(MODULE_QUALIFIED) ?? []),
    ...(query.match(DOTTED) ?? []),
  ];

  for (const match of query.matchAll(QUOTED)) {
    const quoted = match[1]?.trim();
    if (quoted && /^(?:minecraft:|@minecraft\/|[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)$/.test(quoted)) {
      candidates.push(quoted);
    }
  }

  for (const value of query.match(PASCAL) ?? []) {
    if (!GENERIC_PASCAL.has(value)) candidates.push(value);
  }

  return unique(candidates.map(cleanCandidate)).slice(0, 8);
}

function keywords(query: string): string[] {
  const tokens = query.toLocaleLowerCase("en-US").match(/[\p{L}\p{N}_@.$:-]+/gu) ?? [];
  return unique(tokens.filter((token) => token.length > 1 && !STOP_WORDS.has(token))).slice(0, 10);
}

function suggestedKindsFor(intent: BedrockLookupIntent): DocumentKind[] {
  switch (intent) {
    case "definition":
      return ["api", "component", "reference"];
    case "example":
      return ["example", "code"];
    case "debugging":
      return ["docs", "reference", "json", "code"];
    case "manifest":
      return ["json", "docs", "reference"];
    case "version":
      return ["reference", "api", "docs"];
    default:
      return [];
  }
}

export function planBedrockQuery(query: string): BedrockQueryPlan {
  const originalQuery = query;
  const normalizedQuery = normalizeQuery(query);
  const detected = detectBedrockQueryIntent(normalizedQuery);
  const identifiers = extractBedrockIdentifiers(normalizedQuery);
  const fetchId = FETCH_ID.exec(normalizedQuery)?.[0];

  let intent: BedrockLookupIntent = "general";
  let recommendedTool: BedrockLookupTool = "search";
  let confidence = 0.68;
  const reasons: string[] = [];

  if (fetchId) {
    intent = "evidence_fetch";
    recommendedTool = "fetch";
    confidence = 0.99;
    reasons.push("server-issued document/chunk id detected");
  } else if (SOURCE_DISCOVERY.test(normalizedQuery)) {
    intent = "source_discovery";
    recommendedTool = "list_sources";
    confidence = 0.94;
    reasons.push("query asks about indexed sources or provenance");
  } else if (CATEGORY_DISCOVERY.test(normalizedQuery)) {
    intent = "category_discovery";
    recommendedTool = "list_categories";
    confidence = 0.94;
    reasons.push("query asks about indexed knowledge categories");
  } else if (detected.definition || (detected.identifierLike && identifiers.length === 1 && normalizedQuery.split(/\s+/).length <= 5)) {
    intent = "definition";
    recommendedTool = identifiers.length > 0 ? "get_definition" : "search";
    confidence = identifiers.length > 0 ? 0.96 : 0.78;
    reasons.push(identifiers.length > 0 ? "definition intent and identifier candidate detected" : "definition intent detected without a safe exact identifier");
  } else if (detected.example) {
    intent = "example";
    confidence = 0.88;
    reasons.push("example/tutorial intent detected");
  } else if (detected.debugging) {
    intent = "debugging";
    confidence = 0.86;
    reasons.push("debugging/schema/error intent detected");
  } else if (detected.manifest) {
    intent = "manifest";
    confidence = 0.86;
    reasons.push("manifest/dependency intent detected");
  } else if (detected.version) {
    intent = "version";
    confidence = 0.84;
    reasons.push("version/compatibility intent detected");
  }

  if (detected.module) reasons.push(`module detected: ${detected.module}`);
  if (detected.preview) reasons.push("preview/beta material explicitly requested");
  if (detected.stable) reasons.push("stable/release material explicitly requested");

  let searchQuery = normalizedQuery;
  if (recommendedTool === "get_definition" && identifiers[0]) {
    searchQuery = identifiers[0];
  } else if (intent === "version" && detected.module) {
    searchQuery = detected.module;
  }

  return {
    originalQuery,
    normalizedQuery,
    searchQuery,
    intent,
    recommendedTool,
    confidence,
    identifiers,
    keywords: keywords(normalizedQuery),
    suggestedKinds: suggestedKindsFor(intent),
    reasons: reasons.slice(0, 4),
    ...(detected.module ? { module: detected.module } : {}),
    ...(fetchId ? { fetchId } : {}),
    ...(detected.preview ? { includePreview: true } : detected.stable ? { includePreview: false } : {}),
  };
}
