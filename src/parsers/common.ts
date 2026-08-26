import type { Lifecycle, Stability } from "../models/enums.js";

export interface FrontMatterResult {
  attributes: Record<string, string>;
  body: string;
  bodyStartLine: number;
}

export function parseFrontMatter(input: string): FrontMatterResult {
  const normalized = input.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines[0]?.trim() !== "---") {
    return { attributes: {}, body: normalized, bodyStartLine: 1 };
  }

  const attributes: Record<string, string> = {};
  let closing = -1;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (line.trim() === "---") {
      closing = i;
      break;
    }
    const match = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1];
    let value = match[2]?.trim() ?? "";
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) attributes[key] = value;
  }

  if (closing < 0) return { attributes: {}, body: normalized, bodyStartLine: 1 };
  return {
    attributes,
    body: lines.slice(closing + 1).join("\n"),
    bodyStartLine: closing + 2,
  };
}

export function stabilityFromText(text: string): Stability {
  const lower = text.toLocaleLowerCase("en-US");
  if (lower.includes("minecraft-bedrock-experimental") || lower.includes("pre-release") || lower.includes("experimental")) {
    return "experimental";
  }
  if (lower.includes("beta")) return "beta";
  if (lower.includes("internal")) return "internal";
  return "stable";
}

export function lifecycleFromText(text: string, historical = false): Lifecycle {
  if (historical) return "historical";
  const lower = text.toLocaleLowerCase("en-US");
  if (lower.includes("deprecated")) return "deprecated";
  if (lower.includes("removed")) return "removed";
  return "active";
}

export function stripMarkdownDecoration(value: string): string {
  return value
    .replace(/^#+\s*/, "")
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .trim();
}
