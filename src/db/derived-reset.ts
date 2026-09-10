import type { DatabaseSync } from "node:sqlite";
import { identifierSearchTerms } from "../identifiers/normalize.js";

interface IdentifierRow {
  chunk_id: number;
  identifier: string;
}

/**
 * Remove data produced by post-index derivation and restore each FTS alias field
 * from exact identifiers before deriveScriptApiAliases runs again.
 *
 * Full rebuilds start with an empty database; incremental rebuilds need this
 * explicit reset so removed or changed type relationships cannot leave stale
 * derived aliases in either identifiers, symbol_edges, or FTS text.
 */
export function resetDerivedIndexData(database: DatabaseSync): void {
  database.prepare("DELETE FROM identifiers WHERE alias_type = 'derived-chain'").run();
  database.prepare("DELETE FROM symbol_edges").run();

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
