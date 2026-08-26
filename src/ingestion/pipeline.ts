import { extractIdentifiers } from "../identifiers/extract.js";
import type { ParsedDocument } from "../models/document.js";
import type { SourceDescriptor } from "../models/source.js";
import { parseCode } from "../parsers/code.js";
import { parseMarkdown } from "../parsers/markdown.js";
import { parseBedrockJson } from "../parsers/json.js";
import { parseScriptApi } from "../parsers/script-api.js";
import { classifyPath } from "./classifier.js";

export interface IngestInput {
  source: SourceDescriptor;
  path: string;
  content: string;
  canonicalUrl?: string;
}

export function ingestDocument(input: IngestInput): ParsedDocument {
  const classification = classifyPath(input.path);
  let title = input.path.split("/").at(-1) ?? input.path;
  let description: string | undefined;
  let apiPackage: string | undefined;
  let chunks;

  if (classification.kind === "api") {
    const parsed = parseScriptApi(input.content, input.path);
    title = parsed.title;
    description = parsed.frontMatter.description;
    apiPackage = parsed.apiPackage;
    chunks = parsed.chunks;
  } else if (classification.language === "markdown") {
    const parsed = parseMarkdown(input.content);
    title = parsed.title;
    description = parsed.frontMatter.description;
    chunks = parsed.chunks;
  } else if (classification.language === "json") {
    const parsed = parseBedrockJson(input.content, input.path);
    title = parsed.title;
    chunks = parsed.chunks;
  } else if (classification.language === "typescript" || classification.language === "javascript") {
    chunks = parseCode(input.content, input.path);
  } else {
    chunks = [
      {
        ordinal: 0,
        chunkType: "document" as const,
        title,
        headingPath: [] as string[],
        content: input.content,
        startLine: 1,
        endLine: input.content.split(/\r?\n/).length,
        identifiers: extractIdentifiers(input.content),
        stability: "stable" as const,
        lifecycle: classification.lifecycle,
        language: classification.language,
      },
    ];
  }

  const identifiers = [...new Set(chunks.flatMap((chunk) => chunk.identifiers))];
  const stability = chunks.length > 0 && chunks.every((chunk) => chunk.stability === "experimental") ? "experimental" : "stable";

  return {
    metadata: {
      source: input.source,
      path: input.path,
      title,
      kind: classification.kind,
      category: classification.category,
      language: classification.language,
      channel: input.source.channel,
      stability,
      lifecycle: classification.lifecycle,
      ...(description ? { description } : {}),
      ...(apiPackage ? { apiPackage } : {}),
      ...(input.canonicalUrl ? { canonicalUrl: input.canonicalUrl } : {}),
    },
    rawContent: input.content,
    chunks,
    identifiers,
  };
}
