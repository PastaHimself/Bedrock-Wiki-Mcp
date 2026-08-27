import { extractJsonIdentifiers } from "../identifiers/extract.js";
import type { ChunkDraft } from "../models/chunk.js";
import type { Lifecycle, SymbolKind } from "../models/enums.js";

export interface JsonParseResult {
  title: string;
  chunks: ChunkDraft[];
  identifiers: string[];
  minecraftVersion?: string;
}

function escapePointer(value: string): string {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function inferredLifecycle(value: unknown): Lifecycle {
  return objectRecord(value)?.deprecated === true ? "deprecated" : "active";
}

function pushChunk(
  chunks: ChunkDraft[],
  title: string,
  pointer: string,
  value: unknown,
  identifiers: string[],
  symbolKind: SymbolKind,
  contentWrapper?: unknown,
  lifecycle: Lifecycle = "active",
): void {
  chunks.push({
    ordinal: chunks.length,
    chunkType: "json-object",
    title,
    headingPath: [title],
    content: pretty(contentWrapper ?? value),
    startLine: 1,
    endLine: 1,
    identifiers: [...new Set([...identifiers, ...extractJsonIdentifiers(value)])],
    stability: "stable",
    lifecycle,
    language: "json",
    jsonPointer: pointer,
    ...(identifiers[0] ? { identifier: identifiers[0] } : {}),
    symbolKind,
  });
}

function schemaTitle(root: Record<string, unknown>, path: string): string | null {
  const title = typeof root.title === "string" ? root.title.trim() : "";
  const looksLikeSchema = typeof root.$schema === "string"
    || typeof root.$id === "string"
    || objectRecord(root.properties) !== null
    || Array.isArray(root.enum);
  if (!looksLikeSchema) return null;
  return title || path.split("/").at(-1) || path;
}

function schemaOverview(root: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(root).filter(([key]) => key !== "properties"));
}

function propertyIdentifiers(parentTitle: string, property: string): string[] {
  const scoped = /^[A-Za-z_$][\w$]*$/.test(property) ? `${parentTitle}.${property}` : undefined;
  const primary = property.startsWith("minecraft:") ? property : scoped ?? property;
  return [...new Set([primary, property, parentTitle])];
}

export function parseBedrockJson(input: string, path: string): JsonParseResult {
  let root: unknown;
  try {
    root = JSON.parse(input) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in ${path}: ${detail}`);
  }

  const rootObject = objectRecord(root);
  if (!rootObject) {
    return {
      title: path.split("/").at(-1) ?? path,
      identifiers: extractJsonIdentifiers(root),
      chunks: [
        {
          ordinal: 0,
          chunkType: "json-object",
          title: path.split("/").at(-1) ?? path,
          headingPath: [],
          content: pretty(root),
          startLine: 1,
          endLine: input.split(/\r?\n/).length,
          identifiers: extractJsonIdentifiers(root),
          stability: "stable",
          lifecycle: "active",
          language: "json",
          jsonPointer: "",
          symbolKind: "unknown",
        },
      ],
    };
  }

  const chunks: ChunkDraft[] = [];
  const allIdentifiers = extractJsonIdentifiers(root);
  const minecraftVersion = typeof rootObject["x-minecraft-version"] === "string"
    ? rootObject["x-minecraft-version"].trim()
    : undefined;

  const entity = objectRecord(rootObject["minecraft:entity"]);
  if (entity) {
    const description = objectRecord(entity.description);
    const entityId = typeof description?.identifier === "string" ? description.identifier : path.split("/").at(-1) ?? "entity";
    const baseDescription = description ? { description } : {};
    pushChunk(chunks, entityId, "/minecraft:entity/description", description ?? {}, [entityId], "unknown", {
      "minecraft:entity": { ...baseDescription },
    });

    for (const [groupName, kind] of [
      ["components", "component"],
      ["component_groups", "component"],
      ["events", "event"],
    ] as const) {
      const group = objectRecord(entity[groupName]);
      if (!group) continue;
      for (const [key, value] of Object.entries(group)) {
        const pointer = `/minecraft:entity/${escapePointer(groupName)}/${escapePointer(key)}`;
        const wrapper = { "minecraft:entity": { ...baseDescription, [groupName]: { [key]: value } } };
        pushChunk(chunks, `${entityId} — ${key}`, pointer, value, [key, entityId], kind === "component" ? "component" : "event", wrapper);
      }
    }
  }

  const structuredRoots: Array<[string, SymbolKind]> = [
    ["animations", "animation"],
    ["animation_controllers", "animation-controller"],
    ["render_controllers", "render-controller"],
  ];

  for (const [rootKey, symbolKind] of structuredRoots) {
    const group = objectRecord(rootObject[rootKey]);
    if (!group) continue;
    for (const [key, value] of Object.entries(group)) {
      pushChunk(chunks, key, `/${escapePointer(rootKey)}/${escapePointer(key)}`, value, [key], symbolKind, { [rootKey]: { [key]: value } });
    }
  }

  if (chunks.length === 0) {
    const title = schemaTitle(rootObject, path);
    if (title) {
      const overview = schemaOverview(rootObject);
      pushChunk(chunks, title, "", overview, [title], "unknown", overview, inferredLifecycle(rootObject));
      const properties = objectRecord(rootObject.properties);
      if (properties) {
        for (const [key, value] of Object.entries(properties)) {
          const pointer = `/properties/${escapePointer(key)}`;
          const identifiers = propertyIdentifiers(title, key);
          pushChunk(
            chunks,
            `${title} — ${key}`,
            pointer,
            value,
            identifiers,
            "property",
            { title, property: key, schema: value },
            inferredLifecycle(value),
          );
        }
      }
    }
  }

  if (chunks.length === 0) {
    const title = path.split("/").at(-1) ?? path;
    pushChunk(chunks, title, "", root, allIdentifiers, "unknown");
  }

  return {
    title: chunks[0]?.title ?? path,
    chunks: chunks.map((chunk, ordinal) => ({ ...chunk, ordinal, endLine: input.split(/\r?\n/).length })),
    identifiers: [...new Set([...allIdentifiers, ...chunks.flatMap((chunk) => chunk.identifiers)])],
    ...(minecraftVersion ? { minecraftVersion } : {}),
  };
}
