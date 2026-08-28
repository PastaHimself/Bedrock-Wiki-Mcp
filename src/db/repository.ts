import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { identifierLeaf, identifierSearchTerms, normalizeIdentifier } from "../identifiers/normalize.js";
import type { ParsedDocument } from "../models/document.js";
import type { SourceDescriptor } from "../models/source.js";
import { sha256Text } from "../ingestion/hashing.js";

function stablePublicId(prefix: "doc" | "chk", ...parts: string[]): string {
  const digest = createHash("sha256").update(parts.join("\u0000"), "utf8").digest("hex").slice(0, 24);
  return `${prefix}_${digest}`;
}

function safeInteger(value: number | bigint): number {
  const converted = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(converted)) throw new RangeError(`SQLite integer is outside JavaScript safe range: ${String(value)}`);
  return converted;
}

export class IndexRepository {
  readonly #database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.#database = database;
  }

  upsertSource(source: SourceDescriptor): void {
    const sourceType = source.sourceType ?? (source.repository ? "git" : "local");
    this.#database.prepare(`
      INSERT INTO sources(id, name, source_type, tier, repository, branch, channel, current_revision, config_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        source_type = excluded.source_type,
        tier = excluded.tier,
        repository = excluded.repository,
        branch = excluded.branch,
        channel = excluded.channel,
        current_revision = excluded.current_revision,
        config_json = excluded.config_json
    `).run(
      source.id,
      source.name,
      sourceType,
      source.tier,
      source.repository ?? null,
      source.branch ?? null,
      source.channel,
      source.revision ?? null,
      JSON.stringify(source),
    );
  }

  replaceDocument(document: ParsedDocument): string {
    const { metadata } = document;
    const documentPublicId = stablePublicId("doc", metadata.source.id, metadata.path);
    const ownsTransaction = !this.#database.isTransaction;
    if (ownsTransaction) this.#database.exec("BEGIN IMMEDIATE");

    try {
      this.upsertSource(metadata.source);
      this.#deleteDocumentRows(metadata.source.id, metadata.path);

      const documentInsert = this.#database.prepare(`
        INSERT INTO documents(
          document_id, source_id, path, title, description, kind, category, language,
          channel, stability, lifecycle, repository, branch, revision, canonical_url,
          revision_url, source_file_hash, content_hash, source_modified_at, api_package,
          api_version, minecraft_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        documentPublicId,
        metadata.source.id,
        metadata.path,
        metadata.title,
        metadata.description ?? null,
        metadata.kind,
        metadata.category,
        metadata.language,
        metadata.channel,
        metadata.stability,
        metadata.lifecycle,
        metadata.repository ?? null,
        metadata.branch ?? null,
        metadata.revision ?? null,
        metadata.canonicalUrl ?? null,
        metadata.revisionUrl ?? null,
        metadata.sourceFileHash ?? null,
        metadata.contentHash,
        metadata.sourceModifiedAt ?? null,
        metadata.apiPackage ?? null,
        metadata.apiVersion ?? null,
        metadata.minecraftVersion ?? null,
      );
      const documentRowId = safeInteger(documentInsert.lastInsertRowid);

      const insertChunk = this.#database.prepare(`
        INSERT INTO chunks(
          chunk_id, document_id, ordinal, chunk_type, title, heading_path, identifier,
          symbol_kind, language, content, content_hash, start_line, end_line, json_pointer,
          stability, lifecycle
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertIdentifier = this.#database.prepare(`
        INSERT OR IGNORE INTO identifiers(
          chunk_id, identifier, normalized, leaf_name, identifier_kind, is_primary, alias_type
        ) VALUES (?, ?, ?, ?, ?, ?, 'exact')
      `);
      const insertFts = this.#database.prepare(`
        INSERT INTO chunks_fts(rowid, identifier_text, title, heading, aliases, body, path)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      for (const chunk of document.chunks) {
        const chunkHash = sha256Text(chunk.content);
        const chunkPublicId = stablePublicId("chk", documentPublicId, String(chunk.ordinal), chunkHash);
        const chunkInsert = insertChunk.run(
          chunkPublicId,
          documentRowId,
          chunk.ordinal,
          chunk.chunkType,
          chunk.title,
          JSON.stringify(chunk.headingPath),
          chunk.identifier ?? null,
          chunk.symbolKind ?? null,
          chunk.language ?? null,
          chunk.content,
          chunkHash,
          chunk.startLine,
          chunk.endLine,
          chunk.jsonPointer ?? null,
          chunk.stability,
          chunk.lifecycle,
        );
        const chunkRowId = safeInteger(chunkInsert.lastInsertRowid);

        const exactIdentifiers = [...new Set([...(chunk.identifier ? [chunk.identifier] : []), ...chunk.identifiers])];
        const aliasTerms = new Set<string>();
        for (const identifier of exactIdentifiers) {
          insertIdentifier.run(
            chunkRowId,
            identifier,
            normalizeIdentifier(identifier),
            identifierLeaf(identifier),
            chunk.symbolKind ?? "unknown",
            chunk.identifier === identifier ? 1 : 0,
          );
          for (const term of identifierSearchTerms(identifier)) aliasTerms.add(term);
        }

        insertFts.run(
          chunkRowId,
          exactIdentifiers.join(" "),
          chunk.title,
          chunk.headingPath.join(" > "),
          [...aliasTerms].join(" "),
          chunk.content,
          metadata.path,
        );
      }

      this.#database.prepare(`
        INSERT INTO index_meta(key, value) VALUES ('last_document_write', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(new Date().toISOString());
      if (ownsTransaction) this.#database.exec("COMMIT");
      return documentPublicId;
    } catch (error) {
      if (ownsTransaction && this.#database.isTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  removeDocument(sourceId: string, path: string): boolean {
    const ownsTransaction = !this.#database.isTransaction;
    if (ownsTransaction) this.#database.exec("BEGIN IMMEDIATE");
    try {
      const removed = this.#deleteDocumentRows(sourceId, path);
      if (ownsTransaction) this.#database.exec("COMMIT");
      return removed;
    } catch (error) {
      if (ownsTransaction && this.#database.isTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  clearIndex(): void {
    const ownsTransaction = !this.#database.isTransaction;
    if (ownsTransaction) this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database.exec(`
        DELETE FROM chunks_fts;
        DELETE FROM documents;
        DELETE FROM source_revisions;
        DELETE FROM sources;
        DELETE FROM symbol_edges;
        DELETE FROM index_meta WHERE key <> 'schema_version';
      `);
      if (ownsTransaction) this.#database.exec("COMMIT");
    } catch (error) {
      if (ownsTransaction && this.#database.isTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  #deleteDocumentRows(sourceId: string, path: string): boolean {
    const row = this.#database.prepare("SELECT id FROM documents WHERE source_id = ? AND path = ?").get(sourceId, path) as { id: number } | undefined;
    if (!row) return false;
    this.#database.prepare("DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE document_id = ?)").run(row.id);
    this.#database.prepare("DELETE FROM documents WHERE id = ?").run(row.id);
    return true;
  }
}
