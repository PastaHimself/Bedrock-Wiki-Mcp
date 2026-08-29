import { extractIdentifiers } from "../identifiers/extract.js";
import type { ChunkDraft } from "../models/chunk.js";
import type { ParsedDocument } from "../models/document.js";
import type { SourceDescriptor } from "../models/source.js";
import { parseCode } from "../parsers/code.js";
import { parseMarkdown } from "../parsers/markdown.js";
import { parseBedrockJson } from "../parsers/json.js";
import { parseScriptApi } from "../parsers/script-api.js";
import { classifyPath } from "./classifier.js";
import { sha256Text } from "./hashing.js";

export interface IngestInput {
  source: SourceDescriptor;
  path: string;
  content: string;
  canonicalUrl?: string;
  revisionUrl?: string;
  sourceFileHash?: string;
  sourceModifiedAt?: string;
  apiVersion?: string;
  minecraftVersion?: string;
}

function firstMetadataValue(frontMatter: Record<string, string>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = frontMatter[key];
    if (value) return value;
  }
  return undefined;
}

function categoryForSource(category: string, source: SourceDescriptor): string {
  if (category === "script_api") return source.channel === "preview" ? "script_api_beta" : "script_api_stable";
  if (category !== "documentation" && category !== "scripting" && category !== "json" && category !== "other") return category;
  if (source.id.includes("gametest")) return "gametest";
  if (source.id.includes("editor")) return "editor";
  if (source.id.includes("schema")) return "schemas";
  if (source.id.includes("debugger")) return "debugging";
  if (source.id.includes("protocol")) return "networking_protocol";
  if (source.id.includes("creator_tools")) return "creator_tools";
  return category;
}

export function ingestDocument(input: IngestInput): ParsedDocument {
  const classification = classifyPath(input.path);
  const category = categoryForSource(classification.category, input.source);
  let title = input.path.split("/").at(-1) ?? input.path;
  let description: string | undefined;
  let apiPackage: string | undefined;
  let apiVersion = input.apiVersion;
  let minecraftVersion = input.minecraftVersion;
  let chunks: ChunkDraft[];

  if (classification.kind === "api") {
    const parsed = parseScriptApi(input.content, input.path);
    title = parsed.title;
    description = parsed.frontMatter.description;
    apiPackage = parsed.apiPackage;
    apiVersion ??= firstMetadataValue(parsed.frontMatter, ["api_version", "api-version", "apiVersion"]);
    minecraftVersion ??= firstMetadataValue(parsed.frontMatter, ["minecraft_version", "minecraft-version", "minecraftVersion"]);
    chunks = parsed.chunks;
  } else if (classification.language === "markdown") {
    const parsed = parseMarkdown(input.content);
    title = parsed.title;
    description = parsed.frontMatter.description;
    apiVersion ??= firstMetadataValue(parsed.frontMatter, ["api_version", "api-version", "apiVersion"]);
    minecraftVersion ??= firstMetadataValue(parsed.frontMatter, ["minecraft_version", "minecraft-version", "minecraftVersion"]);
    chunks = parsed.chunks;
  } else if (classification.language === "json") {
    const parsed = parseBedrockJson(input.content, input.path);
    title = parsed.title;
    minecraftVersion ??= parsed.minecraftVersion;
    chunks = parsed.chunks;
  } else if (classification.language === "typescript" || classification.language === "javascript") {
    chunks = parseCode(input.content, input.path);
  } else {
    chunks = [
      {
        ordinal: 0,
        chunkType: "document",
        title,
        headingPath: [],
        content: input.content,
        startLine: 1,
        endLine: input.content.split(/\r?\n/).length,
        identifiers: extractIdentifiers(input.content),
        stability: "stable",
        lifecycle: classification.lifecycle,
        language: classification.language,
      },
    ];
  }

  const identifiers = [...new Set(chunks.flatMap((chunk) => chunk.identifiers))];
  const stability = chunks.length > 0 && chunks.every((chunk) => chunk.stability === "experimental") ? "experimental" : "stable";
  const contentHash = sha256Text(input.content);

  return {
    metadata: {
      source: input.source,
      path: input.path,
      title,
      kind: classification.kind,
      category,
      language: classification.language,
      channel: input.source.channel,
      stability,
      lifecycle: classification.lifecycle,
      contentHash,
      ...(description ? { description } : {}),
      ...(input.source.repository ? { repository: input.source.repository } : {}),
      ...(input.source.branch ? { branch: input.source.branch } : {}),
      ...(input.source.revision ? { revision: input.source.revision } : {}),
      ...(input.sourceFileHash ? { sourceFileHash: input.sourceFileHash } : {}),
      ...(apiPackage ? { apiPackage } : {}),
      ...(apiVersion ? { apiVersion } : {}),
      ...(minecraftVersion ? { minecraftVersion } : {}),
      ...(input.canonicalUrl ? { canonicalUrl: input.canonicalUrl } : {}),
      ...(input.revisionUrl ? { revisionUrl: input.revisionUrl } : {}),
      ...(input.sourceModifiedAt ? { sourceModifiedAt: input.sourceModifiedAt } : {}),
    },
    rawContent: input.content,
    chunks,
    identifiers,
  };
}
