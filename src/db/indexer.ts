import type { DatabaseSync } from "node:sqlite";
import { ingestLocalDirectory, type LocalIngestionOptions } from "../ingestion/local.js";
import type { SourceDescriptor } from "../models/source.js";
import { IndexRepository } from "./repository.js";
import { validateIndex, type IndexValidationReport } from "./validate.js";

export interface RebuildLocalIndexOptions extends LocalIngestionOptions {
  directory: string;
  source: SourceDescriptor;
}

export interface RebuildLocalIndexResult {
  documentsIndexed: number;
  chunksIndexed: number;
  identifiersIndexed: number;
  validation: IndexValidationReport;
}

export async function rebuildLocalIndex(
  database: DatabaseSync,
  options: RebuildLocalIndexOptions,
): Promise<RebuildLocalIndexResult> {
  const repository = new IndexRepository(database);
  const documents = await ingestLocalDirectory(options.directory, options.source, {
    ...(options.maxFileBytes !== undefined ? { maxFileBytes: options.maxFileBytes } : {}),
    ...(options.extensions !== undefined ? { extensions: options.extensions } : {}),
  });

  database.exec("BEGIN IMMEDIATE");
  try {
    repository.clearIndex();
    let chunksIndexed = 0;
    let identifiersIndexed = 0;
    for (const document of documents) {
      repository.replaceDocument(document);
      chunksIndexed += document.chunks.length;
      identifiersIndexed += document.chunks.reduce((count, chunk) => count + new Set(chunk.identifiers).size, 0);
    }

    const validation = validateIndex(database);
    if (!validation.ok) {
      throw new Error(`Index validation failed after rebuild: ${validation.errors.join("; ")}`);
    }

    database.exec("COMMIT");
    return {
      documentsIndexed: documents.length,
      chunksIndexed,
      identifiersIndexed,
      validation,
    };
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  }
}
