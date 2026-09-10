import { copyFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { ParsedDocument } from "../models/document.js";
import type { SourceDescriptor } from "../models/source.js";
import { openSourceCheckout, sourceCheckoutRoot, walkSourceCheckoutDocuments } from "../sources/checkout.js";
import { loadSourceRegistry, selectConfiguredSources, sourceDescriptor } from "../sources/config.js";
import { loadNpmSourceRegistry, openNpmSnapshot, selectNpmSources, walkNpmSnapshotDocuments } from "../sources/npm.js";
import { deriveScriptApiAliases } from "./aliases.js";
import { openDatabase } from "./connection.js";
import { resetDerivedIndexData } from "./derived-reset.js";
import { migrateDatabase } from "./migrate.js";
import { IndexRepository } from "./repository.js";
import {
  rebuildConfiguredSourcesIndex,
  type RebuildSourcesIndexOptions,
  type SourceIndexStats,
} from "./source-indexer.js";
import { validateIndex, type IndexValidationReport } from "./validate.js";

interface ExistingDocumentRow {
  path: string;
  content_hash: string;
  chunks: number;
}

interface IncrementalSourceResult {
  stats: SourceIndexStats;
  revisionChanged: boolean;
  added: number;
  modified: number;
  deleted: number;
  unchanged: number;
  chunksChanged: number;
}

export interface UpdateSourcesIndexResult {
  targetPath: string;
  sources: SourceIndexStats[];
  aliasesDerived: number;
  validation: IndexValidationReport;
  incremental: boolean;
  sourcesChanged: number;
  documentsAdded: number;
  documentsModified: number;
  documentsDeleted: number;
  documentsUnchanged: number;
  chunksChanged: number;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function cleanupBuildFiles(path: string): Promise<void> {
  await Promise.all([
    rm(path, { force: true }),
    rm(`${path}-journal`, { force: true }),
    rm(`${path}-wal`, { force: true }),
    rm(`${path}-shm`, { force: true }),
  ]);
}

function sourceStats(database: DatabaseSync, sourceId: string, revision: string): SourceIndexStats {
  const row = database.prepare(`
    SELECT
      count(DISTINCT d.id) AS documents,
      count(DISTINCT c.id) AS chunks,
      count(DISTINCT i.id) AS identifiers
    FROM sources s
    LEFT JOIN documents d ON d.source_id = s.id
    LEFT JOIN chunks c ON c.document_id = d.id
    LEFT JOIN identifiers i ON i.chunk_id = c.id
    WHERE s.id = ?
  `).get(sourceId) as { documents: number; chunks: number; identifiers: number } | undefined;
  return {
    sourceId,
    revision,
    documents: row?.documents ?? 0,
    chunks: row?.chunks ?? 0,
    identifiers: row?.identifiers ?? 0,
  };
}

function existingRevision(database: DatabaseSync, sourceId: string): string | undefined {
  const row = database.prepare("SELECT current_revision FROM sources WHERE id = ?").get(sourceId) as { current_revision: string | null } | undefined;
  return row?.current_revision ?? undefined;
}

function existingDocuments(database: DatabaseSync, sourceId: string): Map<string, ExistingDocumentRow> {
  const rows = database.prepare(`
    SELECT d.path, d.content_hash, count(c.id) AS chunks
    FROM documents d
    LEFT JOIN chunks c ON c.document_id = d.id
    WHERE d.source_id = ?
    GROUP BY d.id, d.path, d.content_hash
  `).all(sourceId) as unknown as ExistingDocumentRow[];
  return new Map(rows.map((row) => [row.path, row]));
}

function refreshUnchangedProvenance(database: DatabaseSync, document: ParsedDocument): void {
  const metadata = document.metadata;
  database.prepare(`
    UPDATE documents
    SET repository = ?, branch = ?, revision = ?, canonical_url = ?, revision_url = ?,
        source_file_hash = ?, source_modified_at = ?, api_package = ?, api_version = ?, minecraft_version = ?
    WHERE source_id = ? AND path = ?
  `).run(
    metadata.repository ?? null,
    metadata.branch ?? null,
    metadata.revision ?? null,
    metadata.canonicalUrl ?? null,
    metadata.revisionUrl ?? null,
    metadata.sourceFileHash ?? null,
    metadata.sourceModifiedAt ?? null,
    metadata.apiPackage ?? null,
    metadata.apiVersion ?? null,
    metadata.minecraftVersion ?? null,
    metadata.source.id,
    metadata.path,
  );
}

async function updateSource(
  database: DatabaseSync,
  repository: IndexRepository,
  source: SourceDescriptor,
  revision: string,
  documentsIterable: AsyncIterable<ParsedDocument>,
): Promise<IncrementalSourceResult> {
  const previousRevision = existingRevision(database, source.id);
  if (previousRevision === revision) {
    const stats = sourceStats(database, source.id, revision);
    return {
      stats,
      revisionChanged: false,
      added: 0,
      modified: 0,
      deleted: 0,
      unchanged: stats.documents,
      chunksChanged: 0,
    };
  }

  const startedAt = new Date().toISOString();
  const existing = existingDocuments(database, source.id);
  let added = 0;
  let modified = 0;
  let deleted = 0;
  let unchanged = 0;
  let chunksChanged = 0;

  database.exec("BEGIN IMMEDIATE");
  try {
    repository.upsertSource(source);
    for await (const document of documentsIterable) {
      const before = existing.get(document.metadata.path);
      existing.delete(document.metadata.path);
      if (before?.content_hash === document.metadata.contentHash) {
        unchanged += 1;
        refreshUnchangedProvenance(database, document);
        continue;
      }

      repository.replaceDocument(document);
      if (before) {
        modified += 1;
        chunksChanged += before.chunks + document.chunks.length;
      } else {
        added += 1;
        chunksChanged += document.chunks.length;
      }
    }

    for (const before of existing.values()) {
      if (repository.removeDocument(source.id, before.path)) {
        deleted += 1;
        chunksChanged += before.chunks;
      }
    }

    if (added + modified + unchanged === 0) {
      throw new Error(`SOURCE_EMPTY: ${source.id} produced no indexable Bedrock knowledge`);
    }

    const completedAt = new Date().toISOString();
    database.prepare(`
      UPDATE sources
      SET current_revision = ?, last_indexed_at = ?
      WHERE id = ?
    `).run(revision, completedAt, source.id);
    database.prepare(`
      INSERT INTO source_revisions(
        source_id, revision, started_at, completed_at, status,
        added_files, modified_files, deleted_files, documents_changed, chunks_changed
      ) VALUES (?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?)
    `).run(
      source.id,
      revision,
      startedAt,
      completedAt,
      added,
      modified,
      deleted,
      added + modified + deleted,
      chunksChanged,
    );
    database.exec("COMMIT");
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  }

  return {
    stats: sourceStats(database, source.id, revision),
    revisionChanged: true,
    added,
    modified,
    deleted,
    unchanged,
    chunksChanged,
  };
}

function removeUnselectedSources(database: DatabaseSync, repository: IndexRepository, selectedIds: ReadonlySet<string>): { documents: number; chunks: number } {
  const rows = database.prepare(`
    SELECT d.source_id, d.path, count(c.id) AS chunks
    FROM documents d
    LEFT JOIN chunks c ON c.document_id = d.id
    GROUP BY d.id, d.source_id, d.path
  `).all() as unknown as Array<{ source_id: string; path: string; chunks: number }>;
  let documents = 0;
  let chunks = 0;
  for (const row of rows) {
    if (selectedIds.has(row.source_id)) continue;
    if (repository.removeDocument(row.source_id, row.path)) {
      documents += 1;
      chunks += row.chunks;
    }
  }
  for (const row of database.prepare("SELECT id FROM sources").all() as unknown as Array<{ id: string }>) {
    if (!selectedIds.has(row.id)) database.prepare("DELETE FROM sources WHERE id = ?").run(row.id);
  }
  return { documents, chunks };
}

export async function updateConfiguredSourcesIndex(
  options: RebuildSourcesIndexOptions,
): Promise<UpdateSourcesIndexResult> {
  const dataDir = resolve(options.dataDir);
  const targetPath = join(dataDir, "index", "bedrock.db");
  if (!(await exists(targetPath))) {
    const full = await rebuildConfiguredSourcesIndex(options);
    const documents = full.sources.reduce((sum, source) => sum + source.documents, 0);
    const chunks = full.sources.reduce((sum, source) => sum + source.chunks, 0);
    return {
      ...full,
      incremental: false,
      sourcesChanged: full.sources.length,
      documentsAdded: documents,
      documentsModified: 0,
      documentsDeleted: 0,
      documentsUnchanged: 0,
      chunksChanged: chunks,
    };
  }

  const checkoutRoot = resolve(options.checkoutRoot ?? sourceCheckoutRoot(dataDir));
  const registry = await loadSourceRegistry(options.configPath ?? "config/sources.json");
  const selected = selectConfiguredSources(registry.sources, options.includePreview ?? false);
  if (selected.length === 0) throw new Error("SOURCE_REGISTRY_EMPTY: no enabled sources were selected");

  const npmConfigPath = options.npmConfigPath ?? (options.configPath ? undefined : "config/npm-sources.json");
  const npmSelected = npmConfigPath
    ? selectNpmSources((await loadNpmSourceRegistry(npmConfigPath)).sources, options.includePreview ?? false)
    : [];
  const selectedIds = new Set([...selected.map((source) => source.id), ...npmSelected.map((source) => source.id)]);

  await mkdir(dirname(targetPath), { recursive: true });
  const buildPath = join(dirname(targetPath), `.bedrock-incremental-${process.pid}-${Date.now()}.building.db`);
  await copyFile(targetPath, buildPath);
  const database = openDatabase(buildPath, { journalMode: "delete" });
  const results: IncrementalSourceResult[] = [];
  let aliasesDerived = 0;
  let validation: IndexValidationReport | undefined;

  try {
    migrateDatabase(database);
    const repository = new IndexRepository(database);

    for (const sourceConfig of selected) {
      const checkout = await openSourceCheckout(checkoutRoot, sourceConfig);
      const source = sourceDescriptor(sourceConfig, checkout.revision);
      results.push(await updateSource(
        database,
        repository,
        source,
        checkout.revision,
        walkSourceCheckoutDocuments(checkout),
      ));
    }

    for (const npmConfig of npmSelected) {
      const snapshot = await openNpmSnapshot(dataDir, npmConfig);
      results.push(await updateSource(
        database,
        repository,
        snapshot.source,
        snapshot.manifest.revision,
        walkNpmSnapshotDocuments(snapshot),
      ));
    }

    database.exec("BEGIN IMMEDIATE");
    try {
      const removed = removeUnselectedSources(database, repository, selectedIds);
      if (removed.documents > 0) {
        results.push({
          stats: { sourceId: "__removed__", revision: "removed", documents: 0, chunks: 0, identifiers: 0 },
          revisionChanged: true,
          added: 0,
          modified: 0,
          deleted: removed.documents,
          unchanged: 0,
          chunksChanged: removed.chunks,
        });
      }
      if (results.some((result) => result.revisionChanged)) {
        resetDerivedIndexData(database);
        aliasesDerived = deriveScriptApiAliases(database).aliasesInserted;
      } else {
        const row = database.prepare("SELECT count(*) AS count FROM identifiers WHERE alias_type = 'derived-chain'").get() as { count: number };
        aliasesDerived = row.count;
      }
      database.exec("COMMIT");
    } catch (error) {
      if (database.isTransaction) database.exec("ROLLBACK");
      throw error;
    }

    validation = validateIndex(database);
    if (!validation.ok) throw new Error(`Index validation failed: ${validation.errors.join("; ")}`);
    database.exec("PRAGMA optimize");
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    database.close();
    await cleanupBuildFiles(buildPath);
    throw error;
  }

  database.close();
  try {
    await rename(buildPath, targetPath);
  } catch (error) {
    await cleanupBuildFiles(buildPath);
    throw error;
  }

  const realResults = results.filter((result) => result.stats.sourceId !== "__removed__");
  return {
    targetPath,
    sources: realResults.map((result) => result.stats),
    aliasesDerived,
    validation: validation as IndexValidationReport,
    incremental: true,
    sourcesChanged: realResults.filter((result) => result.revisionChanged).length,
    documentsAdded: results.reduce((sum, result) => sum + result.added, 0),
    documentsModified: results.reduce((sum, result) => sum + result.modified, 0),
    documentsDeleted: results.reduce((sum, result) => sum + result.deleted, 0),
    documentsUnchanged: realResults.reduce((sum, result) => sum + result.unchanged, 0),
    chunksChanged: results.reduce((sum, result) => sum + result.chunksChanged, 0),
  };
}
