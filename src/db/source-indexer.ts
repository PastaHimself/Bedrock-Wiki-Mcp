import { randomUUID } from "node:crypto";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { ParsedDocument } from "../models/document.js";
import type { SourceDescriptor } from "../models/source.js";
import { loadSourceRegistry, selectConfiguredSources, sourceDescriptor } from "../sources/config.js";
import { openSourceCheckout, sourceCheckoutRoot, walkSourceCheckoutDocuments } from "../sources/checkout.js";
import { loadNpmSourceRegistry, openNpmSnapshot, selectNpmSources, walkNpmSnapshotDocuments } from "../sources/npm.js";
import { deriveScriptApiAliases } from "./aliases.js";
import { openDatabase } from "./connection.js";
import { migrateDatabase } from "./migrate.js";
import { IndexRepository } from "./repository.js";
import { validateIndex, type IndexValidationReport } from "./validate.js";

export interface SourceIndexStats {
  sourceId: string;
  revision: string;
  documents: number;
  chunks: number;
  identifiers: number;
}

export interface RebuildSourcesIndexOptions {
  dataDir: string;
  checkoutRoot?: string;
  configPath?: string;
  npmConfigPath?: string;
  includePreview?: boolean;
}

export interface RebuildSourcesIndexResult {
  targetPath: string;
  sources: SourceIndexStats[];
  aliasesDerived: number;
  validation: IndexValidationReport;
}

async function cleanupBuildFiles(path: string): Promise<void> {
  await Promise.all([
    rm(path, { force: true }),
    rm(`${path}-journal`, { force: true }),
    rm(`${path}-wal`, { force: true }),
    rm(`${path}-shm`, { force: true }),
  ]);
}

async function indexSource(
  database: DatabaseSync,
  repository: IndexRepository,
  source: SourceDescriptor,
  revision: string,
  documentsIterable: AsyncIterable<ParsedDocument>,
): Promise<SourceIndexStats> {
  const startedAt = new Date().toISOString();
  let documents = 0;
  let chunks = 0;
  let identifiers = 0;

  database.exec("BEGIN IMMEDIATE");
  try {
    repository.upsertSource(source);
    for await (const document of documentsIterable) {
      repository.replaceDocument(document);
      documents += 1;
      chunks += document.chunks.length;
      identifiers += document.chunks.reduce((count, chunk) => count + new Set(chunk.identifiers).size, 0);
    }

    if (documents === 0 || chunks === 0) {
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
        added_files, documents_changed, chunks_changed
      ) VALUES (?, ?, ?, ?, 'completed', ?, ?, ?)
    `).run(source.id, revision, startedAt, completedAt, documents, documents, chunks);
    database.exec("COMMIT");
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  }

  return { sourceId: source.id, revision, documents, chunks, identifiers };
}

export async function rebuildConfiguredSourcesIndex(
  options: RebuildSourcesIndexOptions,
): Promise<RebuildSourcesIndexResult> {
  const dataDir = resolve(options.dataDir);
  const targetPath = join(dataDir, "index", "bedrock.db");
  const checkoutRoot = resolve(options.checkoutRoot ?? sourceCheckoutRoot(dataDir));
  const registry = await loadSourceRegistry(options.configPath ?? "config/sources.json");
  const selected = selectConfiguredSources(registry.sources, options.includePreview ?? false);
  if (selected.length === 0) throw new Error("SOURCE_REGISTRY_EMPTY: no enabled sources were selected");

  await mkdir(dirname(targetPath), { recursive: true });
  const buildPath = join(dirname(targetPath), `.bedrock-${randomUUID()}.building.db`);
  // The staging database has exactly one writer and is never served directly.
  // Keep it in rollback-journal mode so publishing one SQLite file never depends
  // on WAL/SHM sidecars or unlinking an mmap-backed SHM file after close.
  const database = openDatabase(buildPath, { journalMode: "delete" });
  const stats: SourceIndexStats[] = [];
  let aliasesDerived = 0;
  let validation: IndexValidationReport | undefined;

  try {
    migrateDatabase(database);
    const repository = new IndexRepository(database);

    for (const sourceConfig of selected) {
      const checkout = await openSourceCheckout(checkoutRoot, sourceConfig);
      const source = sourceDescriptor(sourceConfig, checkout.revision);
      stats.push(await indexSource(
        database,
        repository,
        source,
        checkout.revision,
        walkSourceCheckoutDocuments(checkout),
      ));
    }

    // When a caller supplies a custom Git registry (as tests and private curated
    // deployments often do), do not implicitly mix in the repository's default
    // npm registry. Production/default rebuilds include the official npm sources.
    const npmConfigPath = options.npmConfigPath ?? (options.configPath ? undefined : "config/npm-sources.json");
    if (npmConfigPath) {
      const npmRegistry = await loadNpmSourceRegistry(npmConfigPath);
      const npmSources = selectNpmSources(npmRegistry.sources, options.includePreview ?? false);
      for (const npmConfig of npmSources) {
        const snapshot = await openNpmSnapshot(dataDir, npmConfig);
        stats.push(await indexSource(
          database,
          repository,
          snapshot.source,
          snapshot.manifest.revision,
          walkNpmSnapshotDocuments(snapshot),
        ));
      }
    }

    database.exec("BEGIN IMMEDIATE");
    try {
      aliasesDerived = deriveScriptApiAliases(database).aliasesInserted;
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

  return {
    targetPath,
    sources: stats,
    aliasesDerived,
    validation: validation as IndexValidationReport,
  };
}
