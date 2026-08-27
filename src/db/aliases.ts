import type { DatabaseSync } from "node:sqlite";
import { identifierLeaf, normalizeIdentifier } from "../identifiers/normalize.js";

const SIMPLE_TYPE = /^[A-Z_$][A-Za-z0-9_$]*$/;
const MAX_ALIAS_DEPTH = 4;
const MAX_DERIVED_ALIASES = 200_000;

interface IdentifierRow {
  chunk_id: number;
  identifier: string;
  normalized: string;
  identifier_kind: string;
  is_primary: number;
  content: string;
}

interface MemberRow extends IdentifierRow {
  owner: string;
  ownerNormalized: string;
  suffix: string;
}

interface PropertyRelation {
  propertyIdentifier: string;
  propertyNormalized: string;
  targetType: string;
  targetTypeNormalized: string;
  sourceChunkId: number;
}

interface AliasSeed {
  aliasPrefix: string;
  targetTypeNormalized: string;
  depth: number;
}

export interface AliasDerivationReport {
  propertyTypeEdges: number;
  aliasesInserted: number;
}

function memberParts(identifier: string): { owner: string; suffix: string } | undefined {
  const separator = identifier.lastIndexOf(".");
  if (separator <= 0 || separator === identifier.length - 1) return undefined;
  return {
    owner: identifier.slice(0, separator),
    suffix: identifier.slice(separator + 1),
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function signatureType(content: string, propertyIdentifier: string): string | undefined {
  const leaf = identifierLeaf(propertyIdentifier);
  const pattern = new RegExp(`\\b${escapeRegExp(leaf)}\\b\\s*:\\s*([A-Z_$][A-Za-z0-9_$]*)\\b`);
  return pattern.exec(content)?.[1];
}

/**
 * Build exact aliases for generated Script API property chains.
 *
 * The Creator docs describe relationships in separate files. For example,
 * `World.afterEvents` has type `WorldAfterEvents`, while `playerSpawn` is
 * documented as `WorldAfterEvents.playerSpawn`. This pass links those facts and
 * inserts `World.afterEvents.playerSpawn` as a derived identifier on the
 * canonical member chunk. Identifier normalization makes the common runtime
 * spelling `world.afterEvents.playerSpawn` resolve to the same alias.
 */
export function deriveScriptApiAliases(database: DatabaseSync): AliasDerivationReport {
  const rows = database.prepare(`
    SELECT
      i.chunk_id,
      i.identifier,
      i.normalized,
      i.identifier_kind,
      i.is_primary,
      c.content
    FROM identifiers i
    JOIN chunks c ON c.id = i.chunk_id
    JOIN documents d ON d.id = c.document_id
    WHERE d.kind = 'api'
  `).all() as unknown as IdentifierRow[];

  const rowsByChunk = new Map<number, IdentifierRow[]>();
  const membersByOwner = new Map<string, MemberRow[]>();
  const primaryByNormalized = new Map<string, MemberRow>();

  for (const row of rows) {
    const chunkRows = rowsByChunk.get(row.chunk_id) ?? [];
    chunkRows.push(row);
    rowsByChunk.set(row.chunk_id, chunkRows);

    if (row.is_primary !== 1) continue;
    const parts = memberParts(row.identifier);
    if (!parts) continue;
    const member: MemberRow = {
      ...row,
      owner: parts.owner,
      ownerNormalized: normalizeIdentifier(parts.owner),
      suffix: parts.suffix,
    };
    const members = membersByOwner.get(member.ownerNormalized) ?? [];
    members.push(member);
    membersByOwner.set(member.ownerNormalized, members);
    primaryByNormalized.set(member.normalized, member);
  }

  const propertyRelations = new Map<string, PropertyRelation>();
  for (const member of primaryByNormalized.values()) {
    if (member.identifier_kind !== "property") continue;

    const directType = signatureType(member.content, member.identifier);
    let targetType = directType && membersByOwner.has(normalizeIdentifier(directType)) ? directType : undefined;

    if (!targetType) {
      const ownerNormalized = member.ownerNormalized;
      const candidates = (rowsByChunk.get(member.chunk_id) ?? [])
        .filter((row) => row.is_primary === 0)
        .map((row) => row.identifier)
        .filter((identifier) => SIMPLE_TYPE.test(identifier))
        .filter((identifier) => normalizeIdentifier(identifier) !== ownerNormalized)
        .filter((identifier) => membersByOwner.has(normalizeIdentifier(identifier)));
      const unique = [...new Set(candidates)];
      if (unique.length === 1) targetType = unique[0];
    }

    if (!targetType) continue;
    propertyRelations.set(member.normalized, {
      propertyIdentifier: member.identifier,
      propertyNormalized: member.normalized,
      targetType,
      targetTypeNormalized: normalizeIdentifier(targetType),
      sourceChunkId: member.chunk_id,
    });
  }

  const insertIdentifier = database.prepare(`
    INSERT OR IGNORE INTO identifiers(
      chunk_id, identifier, normalized, leaf_name, identifier_kind, is_primary, alias_type
    ) VALUES (?, ?, ?, ?, ?, 0, 'derived-chain')
  `);
  const insertEdge = database.prepare(`
    INSERT OR IGNORE INTO symbol_edges(from_identifier, relation, to_identifier, source_chunk_id)
    VALUES (?, ?, ?, ?)
  `);
  const updateAliases = database.prepare(`
    UPDATE chunks_fts
    SET aliases = trim(aliases || ' ' || ?)
    WHERE rowid = ?
  `);

  let propertyTypeEdges = 0;
  for (const relation of propertyRelations.values()) {
    const result = insertEdge.run(
      relation.propertyIdentifier,
      "property_type",
      relation.targetType,
      relation.sourceChunkId,
    );
    propertyTypeEdges += Number(result.changes);
  }

  const queue: AliasSeed[] = [...propertyRelations.values()].map((relation) => ({
    aliasPrefix: relation.propertyIdentifier,
    targetTypeNormalized: relation.targetTypeNormalized,
    depth: 1,
  }));
  const visited = new Set<string>();
  let aliasesInserted = 0;

  while (queue.length > 0) {
    const seed = queue.shift();
    if (!seed) break;
    if (seed.depth > MAX_ALIAS_DEPTH) continue;

    const visitKey = `${normalizeIdentifier(seed.aliasPrefix)}\u0000${seed.targetTypeNormalized}`;
    if (visited.has(visitKey)) continue;
    visited.add(visitKey);

    for (const member of membersByOwner.get(seed.targetTypeNormalized) ?? []) {
      const alias = `${seed.aliasPrefix}.${member.suffix}`;
      const normalizedAlias = normalizeIdentifier(alias);
      if (normalizedAlias === member.normalized) continue;

      const result = insertIdentifier.run(
        member.chunk_id,
        alias,
        normalizedAlias,
        identifierLeaf(alias),
        member.identifier_kind,
      );
      if (Number(result.changes) > 0) {
        aliasesInserted += 1;
        updateAliases.run(alias, member.chunk_id);
        insertEdge.run(alias, "alias_of", member.identifier, member.chunk_id);
        if (aliasesInserted > MAX_DERIVED_ALIASES) {
          throw new Error(`ALIAS_LIMIT_EXCEEDED: derived more than ${MAX_DERIVED_ALIASES} Script API aliases`);
        }
      }

      const nestedRelation = propertyRelations.get(member.normalized);
      if (nestedRelation && seed.depth < MAX_ALIAS_DEPTH) {
        queue.push({
          aliasPrefix: alias,
          targetTypeNormalized: nestedRelation.targetTypeNormalized,
          depth: seed.depth + 1,
        });
      }
    }
  }

  return { propertyTypeEdges, aliasesInserted };
}
