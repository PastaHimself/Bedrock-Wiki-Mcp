import type { ChunkType, Lifecycle, Stability, SymbolKind } from "./enums.js";

export interface ChunkDraft {
  ordinal: number;
  chunkType: ChunkType;
  title: string;
  headingPath: string[];
  content: string;
  startLine: number;
  endLine: number;
  identifiers: string[];
  stability: Stability;
  lifecycle: Lifecycle;
  identifier?: string;
  symbolKind?: SymbolKind;
  language?: string;
  jsonPointer?: string;
}
