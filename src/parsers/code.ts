import { extractCodeIdentifiers } from "../identifiers/extract.js";
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
    if (!started && /;\s*$/.test(line)) return index;
  }
  return Math.min(lines.length - 1, startIndex + 100);
}

function importsPrefix(lines: string[]): string {
  const imports: string[] = [];
  let collecting = true;
  let pending: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!collecting) break;
    if (pending.length > 0) {
      pending.push(line);
      if (/;\s*$/.test(trimmed) || /from\s+["'][^"']+["']\s*;?\s*$/.test(trimmed)) {
        imports.push(...pending);
        pending = [];
      }
      continue;
    }
    if (trimmed.startsWith("import ")) {
      if (/;\s*$/.test(trimmed) || /from\s+["'][^"']+["']\s*;?\s*$/.test(trimmed)) imports.push(line);
      else pending = [line];
      continue;
    }
    if (trimmed.length === 0 || trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) continue;
    collecting = false;
  }
  return imports.join("\n");
}

function structuralSpans(lines: string[]): Span[] {
  const spans: Span[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    let match = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/.exec(line);
    if (match) {
      spans.push({ title: match[1] ?? "function", symbolKind: "function", startLine: index + 1, endLine: findBalancedEnd(lines, index) + 1 });
      continue;
    }

    match = /^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(line);
    if (match) {
      spans.push({ title: match[1] ?? "class", symbolKind: "class-code", startLine: index + 1, endLine: findBalancedEnd(lines, index) + 1 });
      continue;
    }

    match = /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/.exec(line);
    if (match) {
      spans.push({ title: match[1] ?? "interface", symbolKind: "interface", startLine: index + 1, endLine: findBalancedEnd(lines, index) + 1 });
      continue;
    }

    match = /^\s*(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/.exec(line);
    if (match) {
      spans.push({ title: match[1] ?? "enum", symbolKind: "enum", startLine: index + 1, endLine: findBalancedEnd(lines, index) + 1 });
      continue;
    }

    match = /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/.exec(line);
    if (match) {
      spans.push({ title: match[1] ?? "type", symbolKind: "unknown", startLine: index + 1, endLine: findBalancedEnd(lines, index) + 1 });
      continue;
    }

    match = /^\s*(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.exec(line);
    if (match) {
      spans.push({ title: match[1] ?? "function", symbolKind: "function", startLine: index + 1, endLine: findBalancedEnd(lines, index) + 1 });
      continue;
    }

    match = /([A-Za-z_$][\w$.]*(?:afterEvents|beforeEvents)[\w$.]*)\.subscribe\s*\(/.exec(line)
      ?? /([A-Za-z_$][\w$.]*)\.subscribe\s*\(/.exec(line);
    if (match) {
      spans.push({ title: `${match[1] ?? "event"}.subscribe`, symbolKind: "event-handler", startLine: index + 1, endLine: findBalancedEnd(lines, index) + 1 });
    }
  }

  const unique = new Map<string, Span>();
  for (const span of spans) {
    const key = `${span.startLine}:${span.endLine}:${span.title}`;
    if (!unique.has(key)) unique.set(key, span);
  }
  return [...unique.values()].sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
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
        identifiers: extractCodeIdentifiers(input),
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
    const identifiers = new Set(extractCodeIdentifiers(content));
    identifiers.add(span.title);
    return {
      ordinal,
      chunkType: "code-block" as const,
      title: span.title,
      headingPath: [span.title],
      content,
      startLine: span.startLine,
      endLine: span.endLine,
      identifiers: [...identifiers],
      stability: "stable" as const,
      lifecycle: "active" as const,
      language,
      identifier: span.title,
      symbolKind: span.symbolKind,
    };
  });
}
