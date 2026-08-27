import type { DatabaseSync } from "node:sqlite";
import { exactIdentifierSearch, type ExactIdentifierHit } from "./exact.js";
import { versionCompatibility, versionMatchScore } from "./version.js";

export interface DefinitionLookupOptions {
  identifier: string;
  minecraftVersion?: string;
  apiVersion?: string;
  includePreview?: boolean;
  includeHistorical?: boolean;
}

export interface DefinitionLookupResult {
  identifier: string;
  definitions: ExactIdentifierHit[];
  stableDefinitionFound: boolean;
  warning?: string;
}

function versionAllowed(hit: ExactIdentifierHit, options: DefinitionLookupOptions): boolean {
  if (versionCompatibility(options.minecraftVersion, hit.minecraftVersion) === "mismatch") return false;
  if (versionCompatibility(options.apiVersion, hit.apiVersion) === "mismatch") return false;
  return true;
}

function isAllowed(hit: ExactIdentifierHit, options: DefinitionLookupOptions): boolean {
  if (!(options.includePreview ?? false) && (hit.channel === "preview" || ["beta", "experimental", "internal"].includes(hit.stability))) return false;
  if (!(options.includeHistorical ?? false) && ["historical", "removed"].includes(hit.lifecycle)) return false;
  return versionAllowed(hit, options);
}

function versionScore(hit: ExactIdentifierHit, options: DefinitionLookupOptions): number {
  return versionMatchScore(options.minecraftVersion, hit.minecraftVersion)
    + versionMatchScore(options.apiVersion, hit.apiVersion);
}

export function getDefinition(database: DatabaseSync, options: DefinitionLookupOptions): DefinitionLookupResult {
  const identifier = options.identifier.trim();
  if (identifier.length < 1 || identifier.length > 250) throw new RangeError("identifier must contain 1 to 250 characters");

  const all = exactIdentifierSearch(database, identifier, 30);
  let definitions = all
    .filter((hit) => isAllowed(hit, options))
    .sort((a, b) => versionScore(b, options) - versionScore(a, options))
    .slice(0, 3);
  const stableDefinitionFound = definitions.some((hit) => hit.channel === "stable" && hit.stability === "stable" && hit.lifecycle === "active");

  if (definitions.length === 0 && !(options.includePreview ?? false)) {
    const previewFallback = all
      .filter((hit) => !["historical", "removed"].includes(hit.lifecycle))
      .filter((hit) => versionAllowed(hit, options))
      .sort((a, b) => versionScore(b, options) - versionScore(a, options))
      .slice(0, 3);
    if (previewFallback.length > 0) {
      definitions = previewFallback;
      return {
        identifier,
        definitions,
        stableDefinitionFound: false,
        warning: "No current stable definition was found; returning preview/beta material as an explicit fallback.",
      };
    }
  }

  return {
    identifier,
    definitions,
    stableDefinitionFound,
    ...(definitions.length === 0 ? { warning: "No definition was found for this exact identifier and requested version constraints." } : {}),
  };
}
