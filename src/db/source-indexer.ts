import { randomUUID } from "node:crypto";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { openDatabase } from "./connection.js";
import { migrateDatabase } from "./migrate.js";
import { IndexRepository } from "./repository.js";
import { validateIndex, type IndexValidationReport } from "./validate.js";
import { loadSourceRegistry, sourceDescriptor, type SourceConfigEntry } from "../sources/config.js";
import { openSourceCheckout, sourceCheckoutRoot, walkSourceCheckoutDocuments } from "../sources/checkout.js";

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
  includePreview?: boolean;
}

export interface RebuildSourcesIndexResult {
  targetPath: string;
  sources: SourceIndexStats[];
  validation: IndexValidationReport;
}

function enabledSources(sources: readonly SourceConfigEntry[], includePreview: boolean): SourceConfigEntry[] {
  return sources.filter((source) => {
    if (source.channel === "preview") return includePreview;
    return source.defaultEnabled;
  });
}

async function cleanupBuildFiles(path: string): Promise<void> {
  await Promise.all([
    rm(path, { force: true }),
    rm(`${path}-wal`, { force: true }),
    rm(`${path}-shm`, { force: true }),
  ]);
}

async function cleanupSidecars(path: string): Promise<void> {
  await Promise.all([
    rm(`${path}-wal`, { force: true }),
    rm(`${path}-shm`, { force: true }),
  ]);
}

export async function rebuildConfiguredSourcesIndex(
  options: RebuildSourcesIndexOptions,
): Promise<RebuildSourcesIndexResult> {
  const dataDir = resolve(options.dataDir);
  const targetPath = join(dataDir, "index", "bedrock.db");
  const checkoutRoot = resolve(options.checkoutRoot ?? sourceCheckoutRoot(dataDir));
  const registry = await loadSourceRegistry(options.configPath ?? "config/sources.json");
  const selected = enabledSources(registry.sources, options.includePreview ?? false);
  if (selected.length === 0) throw new Error("SOURCE_REGISTRY_EMPTY: no enabled sources were selected");

  await mkdir(dirname(targetPath), { recursive: true });
  const buildPath = join(dirname(targetPath), `.bedrock-${randomUUID()}.building.db`);
  const database = openDatabase(buildPath);
  const stats: SourceIndexStats[] = [];
  let validation: IndexValidationReport | undefined;

  try {
    migrateDatabase(database);
    const repository = new IndexRepository(database);

    for (const sourceConfig of selected) {
      const checkout = await openSourceCheckout(checkoutRoot, sourceConfig);
      const source = sourceDescriptor(sourceConfig, checkout.revision);
      const startedAt = new Date().toISOString();
      let documents = 0;
      let chunks = 0;
      let identifiers = 0;

      database.exec("BEGIN IMMEDIATE");
      try {
        repository.upsertSource(source);
        for await (const document of walkSourceCheckoutDocuments(checkout)) {
          repository.replaceDocument(document);
          documents += 1;
          chunks += document.chunks.length;
          identifiers += document.chunks.reduce((count, chunk) => count + new Set(chunk.identifiers).size, 0);
        }

        if (documents === 0 || chunks === 0) {
          throw new Error(`SOURCE_EMPTY: ${sourceConfig.id} produced no indexable Bedrock knowledge`);
        }

        const completedAt = new Date().toISOString();
        database.prepare(`
          UPDATE sources
          SET current_revision = ?, last_indexed_at = ?
          WHERE id = ?
        `).run(checkout.revision, completedAt, sourceConfig.id);
        database.prepare(`
          INSERT INTO source_revisions(
            source_id, revision, started_at, completed_at, status,
            added_files, documents_changed, chunks_changed
          ) VALUES (?, ?, ?, ?, 'completed', ?, ?, ?)
        `).run(
          sourceConfig.id,
          checkout.revision,
          startedAt,
          completedAt,
          documents,
          documents,
          chunks,
        );
        database.exec("COMMIT");
      } catch (error) {
        if (database.isTransaction) database.exec("ROLLBACK");
        throw error;
      }

      stats.push({
        sourceId: sourceConfig.id,
        revision: checkout.revision,
        documents,
        chunks,
        identifiers,
      });
    }

    validation = validateIndex(database);
    if (!validation.ok) throw new Error(`Index validation failed: ${validation.errors.join("; ")}`);
    database.exec("PRAGMA optimize");
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    database.close();
    await cleanupBuildFiles(buildPath);
    throw error;
  }

  database.close();
  await cleanupSidecars(buildPath);
  try {
    await rename(buildPath, targetPath);
  } catch (error) {
    await cleanupBuildFiles(buildPath);
    throw error;
  }

  return {
    targetPath,
    sources: stats,
    validation: validation as IndexValidationReport,
  };
}
