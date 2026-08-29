import { normalizeIdentifier } from "./normalize.js";

const NAMESPACED_IDENTIFIER = /\b[A-Za-z_][A-Za-z0-9_.-]*:[A-Za-z_][A-Za-z0-9_./-]*\b/g;
const NPM_PACKAGE = /@minecraft\/[A-Za-z0-9._-]+/g;
const DOTTED_IDENTIFIER = /\b(?:[A-Za-z_$][\w$]*\.)+[A-Za-z_$][\w$]*\b/g;
const MOLANG_IDENTIFIER = /\b(?:query|variable|temp|context|math)\.[A-Za-z_][A-Za-z0-9_.]*\b/gi;
const PASCAL_API_IDENTIFIER = /\b[A-Z][A-Za-z0-9]*(?:AfterEvent|BeforeEvent|EventSignal|Component|Controller|Options|Error|Event|Signal|Permission|Permissions|Manager|Registry|Result|Type|Mode|State)\b/g;
const BACKTICK_TYPE = /`([A-Z][A-Za-z0-9]*(?:\.[A-Za-z_$][\w$]*)?)`/g;
const MARKDOWN_TYPE_LINK = /\[([A-Z][A-Za-z0-9]+)\]\([^)]*\.md(?:#[^)]*)?\)/g;
const COMMAND = /(?:^|[\s`"'(])\/([a-z][a-z0-9_:-]*)\b/gim;
const IMPORT = /\bimport\s+(?:type\s+)?\{([^}]+)\}\s+from\s+["'](@minecraft\/[A-Za-z0-9._-]+)["']/g;
const NAMESPACE_IMPORT = /\bimport\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+["'](@minecraft\/[A-Za-z0-9._-]+)["']/g;

const MANIFEST_FIELDS = new Set([
  "format_version", "header", "modules", "dependencies", "capabilities", "metadata",
  "min_engine_version", "module_name", "uuid", "version", "entry", "type",
]);
const RENDER_CONTROLLER_FIELDS = new Set([
  "geometry", "materials", "textures", "part_visibility", "color", "overlay_color",
  "on_fire_color", "light_color_multiplier", "uv_anim", "arrays",
]);

function addIdentifier(values: Map<string, string>, value: string, includeLeaf = false): void {
  const clean = value.trim().replace(/[.,;:]+$/g, "");
  const normalized = normalizeIdentifier(clean);
  if (normalized.length > 1 && !values.has(normalized)) values.set(normalized, clean);
  if (!includeLeaf) return;
  const leaf = clean.split(".").at(-1);
  if (!leaf || leaf === clean || leaf.length < 3) return;
  const leafNormalized = normalizeIdentifier(leaf);
  if (leafNormalized.length > 1 && !values.has(leafNormalized)) values.set(leafNormalized, leaf);
}

export function extractIdentifiers(text: string): string[] {
  const values = new Map<string, string>();

  for (const regex of [NAMESPACED_IDENTIFIER, NPM_PACKAGE, PASCAL_API_IDENTIFIER]) {
    for (const match of text.matchAll(regex)) addIdentifier(values, match[0]);
  }
  for (const regex of [DOTTED_IDENTIFIER, MOLANG_IDENTIFIER]) {
    for (const match of text.matchAll(regex)) addIdentifier(values, match[0], true);
  }
  for (const regex of [BACKTICK_TYPE, MARKDOWN_TYPE_LINK]) {
    for (const match of text.matchAll(regex)) {
      const captured = match[1];
      if (captured) addIdentifier(values, captured, captured.includes("."));
    }
  }
  for (const match of text.matchAll(COMMAND)) {
    const command = match[1];
    if (command) addIdentifier(values, `/${command}`);
  }

  return [...values.values()];
}

export function extractCodeIdentifiers(text: string): string[] {
  const values = new Map<string, string>();
  for (const value of extractIdentifiers(text)) addIdentifier(values, value, value.includes("."));

  for (const match of text.matchAll(IMPORT)) {
    const imports = match[1] ?? "";
    const moduleName = match[2];
    if (!moduleName) continue;
    addIdentifier(values, moduleName);
    for (const raw of imports.split(",")) {
      const withoutType = raw.trim().replace(/^type\s+/, "");
      const imported = withoutType.split(/\s+as\s+/i)[0]?.trim();
      const local = withoutType.split(/\s+as\s+/i).at(-1)?.trim();
      if (!imported || !/^[A-Za-z_$][\w$]*$/.test(imported)) continue;
      addIdentifier(values, imported);
      addIdentifier(values, `${moduleName}.${imported}`);
      if (local && local !== imported && /^[A-Za-z_$][\w$]*$/.test(local)) addIdentifier(values, local);
    }
  }

  for (const match of text.matchAll(NAMESPACE_IMPORT)) {
    const local = match[1];
    const moduleName = match[2];
    if (!local || !moduleName) continue;
    addIdentifier(values, moduleName);
    addIdentifier(values, local);
  }

  return [...values.values()];
}

export function extractJsonIdentifiers(value: unknown): string[] {
  const found = new Map<string, string>();

  const add = (identifier: string, includeLeaf = false): void => addIdentifier(found, identifier, includeLeaf);

  const visit = (node: unknown, path: readonly string[]): void => {
    if (typeof node === "string") {
      for (const identifier of extractIdentifiers(node)) add(identifier, identifier.includes("."));
      return;
    }

    if (Array.isArray(node)) {
      for (const child of node) visit(child, path);
      return;
    }

    if (node !== null && typeof node === "object") {
      for (const [key, child] of Object.entries(node)) {
        const nextPath = [...path, key];
        if (/^[A-Za-z_][A-Za-z0-9_.-]*:[A-Za-z_][A-Za-z0-9_./-]*$/.test(key) || key.startsWith("@minecraft/")) add(key);

        if (key === "format_version" && (typeof child === "string" || typeof child === "number")) {
          add("format_version");
          add(`format_version:${String(child)}`);
        }

        if (MANIFEST_FIELDS.has(key) && (path.length === 0 || path[0] === "header" || path[0] === "modules" || path[0] === "dependencies")) {
          add(`manifest.${key}`);
        }

        if (path.includes("states")) {
          const statesIndex = path.lastIndexOf("states");
          if (statesIndex === path.length - 1) {
            add(key);
            add(`animation_controller.state.${key}`);
          }
        }

        if (RENDER_CONTROLLER_FIELDS.has(key) && path.includes("render_controllers")) add(`render_controller.${key}`);

        if (path.at(-1) === "properties") {
          add(key);
          add(`schema.${key}`);
        }

        visit(child, nextPath);
      }
    }
  };

  visit(value, []);
  return [...found.values()];
}
