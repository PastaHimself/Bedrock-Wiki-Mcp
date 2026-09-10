import type { DatabaseSync } from "node:sqlite";
import { sha256Text } from "../ingestion/hashing.js";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}

function metaKey(sourceId: string): string {
  return `source_input:${sourceId}`;
}

export function sourceInputIdentity(config: unknown): string {
  return sha256Text(JSON.stringify(canonicalize(config)));
}

export function readSourceInputIdentity(database: DatabaseSync, sourceId: string): string | undefined {
  const row = database.prepare("SELECT value FROM index_meta WHERE key = ?").get(metaKey(sourceId)) as { value: string } | undefined;
  return row?.value;
}

export function writeSourceInputIdentity(database: DatabaseSync, sourceId: string, identity: string): void {
  database.prepare(`
    INSERT INTO index_meta(key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(metaKey(sourceId), identity);
}

export function removeSourceInputIdentity(database: DatabaseSync, sourceId: string): void {
  database.prepare("DELETE FROM index_meta WHERE key = ?").run(metaKey(sourceId));
}
