import { extractIdentifiers } from "../identifiers/extract.js";
import type { ChunkDraft } from "../models/chunk.js";
import type { Lifecycle, Stability, SymbolKind } from "../models/enums.js";
import { lifecycleFromText, parseFrontMatter, stabilityFromText, stripMarkdownDecoration } from "./common.js";

export interface ScriptApiParseResult {
  frontMatter: Record<string, string>;
  title: string;
  apiPackage: string;
  chunks: ChunkDraft[];
}

function packageFromPath(path: string): string {
  const marker = path.includes("/PriorScriptAPI/") ? "/PriorScriptAPI/" : "/ScriptAPI/";
  const suffix = path.split(marker)[1] ?? "";
  const segments = suffix.split("/").filter(Boolean);
  if (segments[0] === "minecraft" && segments[1]) {
    const packageName = segments[1].replace(/-\d+xx$/i, "");
    return `@minecraft/${packageName}`;
  }
  return "@minecraft/server";
}

function symbolKindForGroup(group: string): SymbolKind {
  const normalized = group.toLocaleLowerCase("en-US");
  if (normalized.includes("propert")) return "property";
  if (normalized.includes("method")) return "method";
  if (normalized.includes("event")) return "event";
  if (normalized.includes("enum")) return "enum";
  return "unknown";
}

function classNameFromTitle(title: string): string {
  const clean = stripMarkdownDecoration(title);
  return clean.replace(/\s+(Class|Interface|Enum)\s*$/i, "").replace(/^.*\./, "").trim();
}

function detectDocumentSymbolKind(title: string): SymbolKind {
  if (/\bInterface\b/i.test(title)) return "interface";
  if (/\bEnum\b/i.test(title)) return "enum";
  return "class";
}

export function parseScriptApi(input: string, path: string): ScriptApiParseResult {
  const front = parseFrontMatter(input);
  const lines = front.body.split("\n");
  const titleLine = lines.find((line) => /^#\s+/.test(line)) ?? `# ${front.attributes.title ?? "API"}`;
  const title = stripMarkdownDecoration(titleLine);
  const parentName = classNameFromTitle(title);
  const apiPackage = packageFromPath(path);
  const historical = path.includes("/PriorScriptAPI/");
  const chunks: ChunkDraft[] = [];

  let group = "Overview";
  let activeStability: Stability = historical ? "unknown" : "stable";
  let activeLifecycle: Lifecycle = historical ? "historical" : "active";
  let buffer: string[] = [];
  let bufferTitle = title;
  let bufferStart = front.bodyStartLine;
  let memberIdentifier: string | undefined;
  let memberKind: SymbolKind | undefined;

  const flush = (endLine: number): void => {
    const content = buffer.join("\n").trim();
    if (content.length === 0) {
      buffer = [];
      return;
    }
    const textStability = historical ? activeStability : stabilityFromText(content);
    const textLifecycle = lifecycleFromText(content, historical);
    const identifiers = new Set<string>(extractIdentifiers(content));
    if (memberIdentifier) identifiers.add(memberIdentifier);
    identifiers.add(apiPackage);
    if (parentName) identifiers.add(parentName);

    const chunk: ChunkDraft = {
      ordinal: chunks.length,
      chunkType: memberIdentifier ? "api-member" : "api-overview",
      title: bufferTitle,
      headingPath: memberIdentifier ? [title, group, bufferTitle] : [title],
      content,
      startLine: bufferStart,
      endLine,
      identifiers: [...identifiers],
      stability: textStability === "stable" ? activeStability : textStability,
      lifecycle: textLifecycle === "active" ? activeLifecycle : textLifecycle,
      language: "markdown",
      ...(memberIdentifier ? { identifier: memberIdentifier } : {}),
      ...(memberKind ? { symbolKind: memberKind } : { symbolKind: detectDocumentSymbolKind(title) }),
    };
    chunks.push(chunk);
    buffer = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const absoluteLine = front.bodyStartLine + index;

    const moniker = /^:::\s*moniker\s+range="([^"]+)"/.exec(line.trim());
    if (moniker) {
      flush(absoluteLine - 1);
      if (moniker[1]?.includes("experimental")) activeStability = "experimental";
      bufferStart = absoluteLine + 1;
      continue;
    }
    if (/^:::\s*moniker-end/.test(line.trim())) {
      flush(absoluteLine - 1);
      activeStability = historical ? "unknown" : "stable";
      bufferStart = absoluteLine + 1;
      continue;
    }

    const h2 = /^##\s+(.+?)\s*$/.exec(line);
    if (h2) {
      flush(absoluteLine - 1);
      group = stripMarkdownDecoration(h2[1] ?? "Members");
      bufferTitle = group;
      bufferStart = absoluteLine;
      memberIdentifier = undefined;
      memberKind = undefined;
      buffer.push(line);
      continue;
    }

    const h3 = /^###\s+(.+?)\s*$/.exec(line);
    if (h3) {
      flush(absoluteLine - 1);
      const memberName = stripMarkdownDecoration(h3[1] ?? "Member");
      memberIdentifier = parentName ? `${parentName}.${memberName}` : memberName;
      memberKind = symbolKindForGroup(group);
      bufferTitle = memberName;
      bufferStart = absoluteLine;
      buffer.push(line);
      continue;
    }

    if (/^#\s+/.test(line) && buffer.length === 0) {
      bufferTitle = title;
      bufferStart = absoluteLine;
    }
    buffer.push(line);
  }

  flush(front.bodyStartLine + Math.max(0, lines.length - 1));
  return { frontMatter: front.attributes, title, apiPackage, chunks };
}
