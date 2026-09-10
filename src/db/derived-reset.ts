import type { DatabaseSync } from "node:sqlite";
import { identifierSearchTerms } from "../identifiers/normalize.js";

interface IdentifierRow {
  chunk_id: number;
  identifier: string;
}

/**
 * Remove data produced by Script API alias derivation and restore each FTS
 * alias field from exact identifiers before deriveScriptApiAliases runs again.
 *
 * Only relations owned by the alias derivation pass are cleared so future
 * independently-derived graph relations are not discarded by incremental
 * refreshes.
 */
export function resetDerivedIndexData(database: DatabaseSync): void {
  database.prepare("DELETE FROM identifiers WHERE alias_type = 'derived-chain'").run();
  database.prepare("DELETE FROM symbol_edges WHERE relation IN ('property_type', 'alias_of')").run();

  const rows = database.prepare(`
    SELECT chunk_id, identifier
    FROM identifiers
    WHERE alias_type = 'exact'
    ORDER BY chunk_id ASC, identifier ASC
  `).iterate() as Iterable<IdentifierRow>;
  const update = database.prepare("UPDATE chunks_fts SET aliases = ? WHERE rowid = ?");

  let currentChunkId: number | undefined;
  let terms = new Set<string>();
  const flush = (): void => {
    if (currentChunkId === undefined) return;
    update.run([...terms].join(" "), currentChunkId);
  };

  for (const row of rows) {
    if (currentChunkId !== row.chunk_id) {
      flush();
      currentChunkId = row.chunk_id;
      terms = new Set<string>();
    }
    for (const term of identifierSearchTerms(row.identifier)) terms.add(term);
  }
  flush();
}
