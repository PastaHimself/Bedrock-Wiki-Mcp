import type { DocumentKind, Lifecycle } from "../models/enums.js";

export interface Classification {
  kind: DocumentKind;
  category: string;
  language: string;
  lifecycle: Lifecycle;
}

function documentationCategory(lower: string): string {
  if (/\bmolang\b/.test(lower)) return "molang";
  if (/(?:^|\/)commands?(?:\/|$)/.test(lower)) return "commands";
  if (/gametest/.test(lower)) return "gametest";
  if (/editor/.test(lower)) return "editor";
  if (/schema/.test(lower)) return "schemas";
  if (/debug/.test(lower)) return "debugging";
  if (/protocol|network/.test(lower)) return "networking_protocol";
  if (/animation[_ -]?controllers?/.test(lower)) return "animation_controllers";
  if (/render[_ -]?controllers?/.test(lower)) return "render_controllers";
  if (/(?:^|\/)animations?(?:\/|$)/.test(lower)) return "animations";
  if (/manifest/.test(lower)) return "manifests";
  if (/behavior[_ -]?packs?/.test(lower)) return "behavior_packs";
  if (/resource[_ -]?packs?/.test(lower)) return "resource_packs";
  return "documentation";
}

export function classifyPath(path: string): Classification {
  const normalized = path.replace(/\\/g, "/");
  const lower = normalized.toLocaleLowerCase("en-US");

  if (normalized.includes("/PriorScriptAPI/")) return { kind: "api", category: "script_api_legacy", language: "markdown", lifecycle: "historical" };
  if (normalized.includes("/ScriptAPI/")) return { kind: "api", category: "script_api", language: "markdown", lifecycle: "active" };

  if (lower.endsWith(".mcfunction")) return { kind: "code", category: "commands", language: "mcfunction", lifecycle: "active" };
  if (lower.endsWith(".md") || lower.endsWith(".mdx")) return { kind: "docs", category: documentationCategory(lower), language: "markdown", lifecycle: "active" };
  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return { kind: "code", category: documentationCategory(lower) === "documentation" ? "scripting" : documentationCategory(lower), language: "typescript", lifecycle: "active" };
  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) return { kind: "code", category: documentationCategory(lower) === "documentation" ? "scripting" : documentationCategory(lower), language: "javascript", lifecycle: "active" };

  if (lower.endsWith(".json")) {
    if (lower.includes("animation_controllers/")) return { kind: "json", category: "animation_controllers", language: "json", lifecycle: "active" };
    if (lower.includes("animations/")) return { kind: "json", category: "animations", language: "json", lifecycle: "active" };
    if (lower.includes("render_controllers/")) return { kind: "json", category: "render_controllers", language: "json", lifecycle: "active" };
    if (lower.includes("entities/")) return { kind: "component", category: "entities", language: "json", lifecycle: "active" };
    if (lower.includes("blocks/")) return { kind: "component", category: "blocks", language: "json", lifecycle: "active" };
    if (lower.includes("items/")) return { kind: "component", category: "items", language: "json", lifecycle: "active" };
    if (lower.endsWith("manifest.json")) return { kind: "reference", category: "manifests", language: "json", lifecycle: "active" };
    if (lower.includes("schema")) return { kind: "reference", category: "schemas", language: "json", lifecycle: "active" };
    if (lower.includes("protocol") || lower.includes("network")) return { kind: "reference", category: "networking_protocol", language: "json", lifecycle: "active" };
    if (lower.includes("behavior_pack") || lower.includes("behavior_packs")) return { kind: "json", category: "behavior_packs", language: "json", lifecycle: "active" };
    if (lower.includes("resource_pack") || lower.includes("resource_packs")) return { kind: "json", category: "resource_packs", language: "json", lifecycle: "active" };
    return { kind: "json", category: "json", language: "json", lifecycle: "active" };
  }

  return { kind: "reference", category: documentationCategory(lower) === "documentation" ? "other" : documentationCategory(lower), language: "text", lifecycle: "active" };
}
