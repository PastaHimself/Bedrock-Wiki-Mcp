import { normalizeIdentifier } from "./normalize.js";

const MINECRAFT_IDENTIFIER = /\bminecraft:[A-Za-z0-9_]+(?:[.-][A-Za-z0-9_]+)*\b/g;
const NPM_PACKAGE = /@minecraft\/[A-Za-z0-9_-]+/g;
const DOTTED_IDENTIFIER = /\b(?:[A-Za-z_$][\w$]*\.)+[A-Za-z_$][\w$]*\b/g;
const PASCAL_API_IDENTIFIER = /\b[A-Z][A-Za-z0-9]*(?:AfterEvent|BeforeEvent|EventSignal|Component|Controller|Options|Error|Event|Signal)\b/g;
const BACKTICK_TYPE = /`([A-Z][A-Za-z0-9]*(?:\.[A-Za-z_$][\w$]*)?)`/g;
const MARKDOWN_TYPE_LINK = /\[([A-Z][A-Za-z0-9]+)\]\([^)]*\.md(?:#[^)]*)?\)/g;

export function extractIdentifiers(text: string): string[] {
  const values = new Map<string, string>();
  const add = (value: string): void => {
    const normalized = normalizeIdentifier(value);
    if (normalized.length > 1 && !values.has(normalized)) values.set(normalized, value);
  };

  for (const regex of [MINECRAFT_IDENTIFIER, NPM_PACKAGE, DOTTED_IDENTIFIER, PASCAL_API_IDENTIFIER]) {
    for (const match of text.matchAll(regex)) add(match[0]);
  }

  for (const regex of [BACKTICK_TYPE, MARKDOWN_TYPE_LINK]) {
    for (const match of text.matchAll(regex)) {
      const captured = match[1];
      if (captured) add(captured);
    }
  }

  return [...values.values()];
}

export function extractJsonIdentifiers(value: unknown): string[] {
  const found = new Map<string, string>();

  const visit = (node: unknown): void => {
    if (typeof node === "string") {
      if (node.startsWith("minecraft:") || node.startsWith("@minecraft/")) {
        found.set(normalizeIdentifier(node), node);
      }
      return;
    }

    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }

    if (node !== null && typeof node === "object") {
      for (const [key, child] of Object.entries(node)) {
        if (key.startsWith("minecraft:") || key.startsWith("@minecraft/")) {
          found.set(normalizeIdentifier(key), key);
        }
        visit(child);
      }
    }
  };

  visit(value);
  return [...found.values()];
}
