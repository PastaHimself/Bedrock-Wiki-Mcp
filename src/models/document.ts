import type { ChunkDraft } from "./chunk.js";
import type { DocumentKind, Lifecycle, ReleaseChannel, Stability } from "./enums.js";
import type { SourceDescriptor } from "./source.js";

export interface DocumentMetadata {
  source: SourceDescriptor;
  path: string;
  title: string;
  kind: DocumentKind;
  category: string;
  language: string;
  channel: ReleaseChannel;
  stability: Stability;
  lifecycle: Lifecycle;
  contentHash: string;
  description?: string;
  repository?: string;
  branch?: string;
  revision?: string;
  sourceFileHash?: string;
  apiPackage?: string;
  apiVersion?: string;
  minecraftVersion?: string;
  canonicalUrl?: string;
  revisionUrl?: string;
  sourceModifiedAt?: string;
}

export interface ParsedDocument {
  metadata: DocumentMetadata;
  rawContent: string;
  chunks: ChunkDraft[];
  identifiers: string[];
}
