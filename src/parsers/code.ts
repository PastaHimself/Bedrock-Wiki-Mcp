import { extractIdentifiers } from "../identifiers/extract.js";
import type { ChunkDraft } from "../models/chunk.js";
import type { SymbolKind } from "../models/enums.js";

interface Span {
  title: string;
  symbolKind: SymbolKind;
  startLine: number;
  endLine: number;
}

function findBalancedEnd(lines: string[], startIndex: number): number {
  let depth = 0;
  let started = false;
  let quote: "'" | '"' | "`" | null = null;
  let escaped = false;

  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    for (let charIndex = 0; charIndex < line.length; charIndex += 1) {
      const char = line[charIndex] ?? "";
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (quote) {
        if (char === quote) quote = null;
        continue;
      }
      if (char === "'" || char === '"' || char === "`") {
        quote = char;
        continue;
      }
      if (char === "{") {
        depth += 1;
        started = true;
      } else if (char === "}") {
        depth -= 1;
        if (started && depth <= 0) return index;
      }
    }
  }
  return Math.min(lines.length - 1, startIndex + 80);
}

function importsPrefix(lines: string[]): string {
  const imports: string[] = [];
  let collecting = true;
  for (const line of lines) {
    const trimmed = line.trim();
    if (collecting && (trimmed.startsWith("import ") || trimmed.startsWith("export ") || trimmed.length === 0)) {
      if (trimmed.startsWith("import ")) imports.push(line);
      continue;
    }
    collecting = false;
  }
  return imports.join("\n");
}

function structuralSpans(lines: string[]): Span[] {
  const spans: Span[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    let match = /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/.exec(line);
    if (match) {
      spans.push({ title: match[1] ?? "function", symbolKind: "function", startLine: index + 1, endLine: findBalancedEnd(lines, index) + 1 });
      index = (spans.at(-1)?.endLine ?? index + 1) - 1;
      continue;
    }

    match = /^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(line);
    if (match) {
      spans.push({ title: match[1] ?? "class", symbolKind: "class-code", startLine: index + 1, endLine: findBalancedEnd(lines, index) + 1 });
      index = (spans.at(-1)?.endLine ?? index + 1) - 1;
      continue;
    }

    match = /([A-Za-z_$][\w$.]*)\.subscribe\s*\(/.exec(line);
    if (match) {
      spans.push({ title: `${match[1] ?? "event"}.subscribe`, symbolKind: "event-handler", startLine: index + 1, endLine: findBalancedEnd(lines, index) + 1 });
      index = (spans.at(-1)?.endLine ?? index + 1) - 1;
    }
  }
  return spans;
}

export function parseCode(input: string, path: string): ChunkDraft[] {
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  const imports = importsPrefix(lines);
  const spans = structuralSpans(lines);
  const language = /\.tsx?$/.test(path) ? "typescript" : "javascript";

  if (spans.length === 0) {
    return [
      {
        ordinal: 0,
        chunkType: "code-block",
        title: path.split("/").at(-1) ?? path,
        headingPath: [],
        content: input,
        startLine: 1,
        endLine: lines.length,
        identifiers: extractIdentifiers(input),
        stability: "stable",
        lifecycle: "active",
        language,
        symbolKind: "unknown",
      },
    ];
  }

  return spans.map((span, ordinal) => {
    const body = lines.slice(span.startLine - 1, span.endLine).join("\n");
    const content = imports.length > 0 && !body.startsWith(imports) ? `${imports}\n\n${body}` : body;
    return {
      ordinal,
      chunkType: "code-block" as const,
      title: span.title,
      headingPath: [span.title],
      content,
      startLine: span.startLine,
      endLine: span.endLine,
      identifiers: extractIdentifiers(content),
      stability: "stable" as const,
      lifecycle: "active" as const,
      language,
      identifier: span.title,
      symbolKind: span.symbolKind,
    };
  });
}
