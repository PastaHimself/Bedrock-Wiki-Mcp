import { extractIdentifiers } from "../identifiers/extract.js";
import type { ChunkDraft } from "../models/chunk.js";
import { lifecycleFromText, parseFrontMatter, stabilityFromText, stripMarkdownDecoration } from "./common.js";

interface MarkdownSection {
  title: string;
  headingPath: string[];
  lines: string[];
  startLine: number;
  endLine: number;
}

export interface MarkdownParseResult {
  frontMatter: Record<string, string>;
  title: string;
  chunks: ChunkDraft[];
}

const MAX_CHARS = 3600;

function sectionsFromMarkdown(body: string, bodyStartLine: number): MarkdownSection[] {
  const lines = body.split("\n");
  const sections: MarkdownSection[] = [];
  const headingStack: string[] = [];
  let inFence = false;
  let current: MarkdownSection = {
    title: "Document",
    headingPath: [],
    lines: [],
    startLine: bodyStartLine,
    endLine: bodyStartLine,
  };

  const flush = (lineIndex: number): void => {
    if (current.lines.some((line) => line.trim().length > 0)) {
      current.endLine = bodyStartLine + Math.max(0, lineIndex - 1);
      sections.push(current);
    }
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (/^\s*```/.test(line) || /^\s*~~~/.test(line)) inFence = !inFence;

    const heading = !inFence ? /^(#{1,6})\s+(.+?)\s*$/.exec(line) : null;
    if (heading) {
      flush(index);
      const level = heading[1]?.length ?? 1;
      const title = stripMarkdownDecoration(heading[2] ?? "Section");
      headingStack.splice(level - 1);
      headingStack[level - 1] = title;
      current = {
        title,
        headingPath: headingStack.filter(Boolean),
        lines: [line],
        startLine: bodyStartLine + index,
        endLine: bodyStartLine + index,
      };
      continue;
    }

    current.lines.push(line);
  }

  flush(lines.length);
  return sections;
}

function splitAtoms(lines: string[]): string[] {
  const atoms: string[] = [];
  let buffer: string[] = [];
  let inFence = false;

  const flush = (): void => {
    const text = buffer.join("\n").trimEnd();
    if (text.trim().length > 0) atoms.push(text);
    buffer = [];
  };

  for (const line of lines) {
    const fence = /^\s*```/.test(line) || /^\s*~~~/.test(line);
    if (!inFence && line.trim().length === 0) {
      flush();
      continue;
    }
    buffer.push(line);
    if (fence) inFence = !inFence;
  }
  flush();
  return atoms;
}

function splitSection(section: MarkdownSection): Array<{ content: string; startLine: number; endLine: number }> {
  const text = section.lines.join("\n").trim();
  if (text.length <= MAX_CHARS) {
    return [{ content: text, startLine: section.startLine, endLine: section.endLine }];
  }

  const atoms = splitAtoms(section.lines);
  const result: Array<{ content: string; startLine: number; endLine: number }> = [];
  let buffer: string[] = [];
  let estimatedStart = section.startLine;

  const flush = (): void => {
    if (buffer.length === 0) return;
    const content = buffer.join("\n\n");
    const lines = content.split("\n").length;
    result.push({ content, startLine: estimatedStart, endLine: estimatedStart + lines - 1 });
    estimatedStart += lines;
    buffer = [];
  };

  for (const atom of atoms) {
    const nextLength = buffer.length === 0 ? atom.length : buffer.join("\n\n").length + 2 + atom.length;
    if (buffer.length > 0 && nextLength > MAX_CHARS) flush();
    buffer.push(atom);
  }
  flush();
  return result;
}

export function parseMarkdown(input: string): MarkdownParseResult {
  const front = parseFrontMatter(input);
  const sections = sectionsFromMarkdown(front.body, front.bodyStartLine);
  const title = front.attributes.title ?? sections.find((section) => section.headingPath.length === 1)?.title ?? "Untitled";
  const chunks: ChunkDraft[] = [];

  for (const section of sections) {
    for (const split of splitSection(section)) {
      const stability = stabilityFromText(split.content);
      const lifecycle = lifecycleFromText(split.content);
      const identifiers = extractIdentifiers(split.content);
      chunks.push({
        ordinal: chunks.length,
        chunkType: section.headingPath.length === 0 ? "document" : "section",
        title: section.title,
        headingPath: [...section.headingPath],
        content: split.content,
        startLine: split.startLine,
        endLine: split.endLine,
        identifiers,
        stability,
        lifecycle,
        language: "markdown",
      });
    }
  }

  return { frontMatter: front.attributes, title, chunks };
}
