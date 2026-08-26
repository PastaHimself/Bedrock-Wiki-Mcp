import type { DocumentKind, Lifecycle } from "../models/enums.js";

export interface Classification {
  kind: DocumentKind;
  category: string;
  language: string;
  lifecycle: Lifecycle;
}

export function classifyPath(path: string): Classification {
  const normalized = path.replace(/\\/g, "/");
  const lower = normalized.toLocaleLowerCase("en-US");

  if (normalized.includes("/PriorScriptAPI/")) return { kind: "api", category: "script_api", language: "markdown", lifecycle: "historical" };
  if (normalized.includes("/ScriptAPI/")) return { kind: "api", category: "script_api", language: "markdown", lifecycle: "active" };

  if (lower.endsWith(".md") || lower.endsWith(".mdx")) return { kind: "docs", category: "documentation", language: "markdown", lifecycle: "active" };
  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return { kind: "code", category: "scripting", language: "typescript", lifecycle: "active" };
  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) return { kind: "code", category: "scripting", language: "javascript", lifecycle: "active" };

  if (lower.endsWith(".json")) {
    if (lower.includes("animation_controllers/")) return { kind: "json", category: "animation_controllers", language: "json", lifecycle: "active" };
    if (lower.includes("animations/")) return { kind: "json", category: "animations", language: "json", lifecycle: "active" };
    if (lower.includes("render_controllers/")) return { kind: "json", category: "render_controllers", language: "json", lifecycle: "active" };
    if (lower.includes("entities/")) return { kind: "component", category: "entities", language: "json", lifecycle: "active" };
    if (lower.includes("blocks/")) return { kind: "component", category: "blocks", language: "json", lifecycle: "active" };
    if (lower.includes("items/")) return { kind: "component", category: "items", language: "json", lifecycle: "active" };
    if (lower.endsWith("manifest.json")) return { kind: "reference", category: "manifests", language: "json", lifecycle: "active" };
    return { kind: "json", category: "json", language: "json", lifecycle: "active" };
  }

  return { kind: "reference", category: "other", language: "text", lifecycle: "active" };
}
