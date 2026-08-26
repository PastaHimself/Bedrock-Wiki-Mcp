import type { DatabaseSync } from "node:sqlite";
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { getDefinition } from "../search/definition.js";
import { listKnowledgeCategories, listKnowledgeSources } from "../search/discovery.js";
import { searchKnowledge } from "../search/engine.js";
import { fetchKnowledge } from "../search/fetch.js";

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const kindSchema = z.enum(["docs", "api", "component", "json", "code", "example", "reference"]);
const stabilitySchema = z.enum(["stable", "beta", "experimental", "internal", "unknown"]);

const provenanceShape = {
  repository: z.string().optional(),
  revision: z.string().optional(),
  canonicalUrl: z.string().optional(),
  revisionUrl: z.string().optional(),
  apiPackage: z.string().optional(),
  apiVersion: z.string().optional(),
  minecraftVersion: z.string().optional(),
};

const searchResultSchema = z.object({
  chunkId: z.string(),
  documentId: z.string(),
  title: z.string(),
  identifier: z.string().optional(),
  excerpt: z.string(),
  path: z.string(),
  kind: z.string(),
  category: z.string(),
  stability: z.string(),
  lifecycle: z.string(),
  channel: z.string(),
  sourceId: z.string(),
  sourceName: z.string(),
  sourceTier: z.number().int(),
  score: z.number(),
  exactMatch: z.boolean(),
  ...provenanceShape,
});

const definitionSchema = z.object({
  chunkId: z.string(),
  documentId: z.string(),
  identifier: z.string(),
  title: z.string(),
  content: z.string(),
  path: z.string(),
  kind: z.string(),
  category: z.string(),
  stability: z.string(),
  lifecycle: z.string(),
  channel: z.string(),
  sourceId: z.string(),
  sourceName: z.string(),
  sourceTier: z.number().int(),
  isPrimary: z.boolean(),
  ...provenanceShape,
});

function textResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
  };
}

function toolError(error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown tool error";
  const safeMessage = message
    .replace(/\b(?:SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|PRAGMA)\b[\s\S]*/gi, "internal index error")
    .slice(0, 500);
  return {
    content: [{ type: "text" as const, text: safeMessage }],
    isError: true,
  };
}

function requireDatabase(database: DatabaseSync | undefined): DatabaseSync {
  if (!database) throw new Error("INDEX_UNAVAILABLE: the knowledge index is not open; build the index before using retrieval tools");
  return database;
}

export function registerKnowledgeTools(server: McpServer, database?: DatabaseSync): void {
  server.registerTool(
    "search",
    {
      title: "Search Bedrock knowledge",
      description: "Search indexed Minecraft Bedrock documentation, Script API definitions, JSON, and code. Exact identifiers receive dominant relevance; preview and historical material are excluded by default.",
      annotations: READ_ONLY,
      inputSchema: z.object({
        query: z.string().trim().min(1).max(500).describe("Exact Bedrock identifier or natural-language question"),
        limit: z.number().int().min(1).max(10).optional(),
        kinds: z.array(kindSchema).max(10).optional(),
        categories: z.array(z.string().min(1).max(100)).max(10).optional(),
        stabilities: z.array(stabilitySchema).max(5).optional(),
        sourceTiers: z.array(z.number().int().min(1).max(4)).max(4).optional(),
        minecraftVersion: z.string().min(1).max(50).optional(),
        includePreview: z.boolean().optional(),
        includeHistorical: z.boolean().optional(),
        maxChars: z.number().int().min(2000).max(24000).optional(),
      }),
      outputSchema: z.object({
        query: z.string(),
        results: z.array(searchResultSchema),
        truncated: z.boolean(),
        totalChars: z.number().int(),
      }),
    },
    async (args) => {
      try {
        return textResult(searchKnowledge(requireDatabase(database), args));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "fetch",
    {
      title: "Fetch Bedrock evidence",
      description: "Fetch a document or chunk returned by search using only server-issued doc_* or chk_* IDs. Arbitrary filesystem paths are never accepted.",
      annotations: READ_ONLY,
      inputSchema: z.object({
        id: z.string().min(1).max(64),
        contextBefore: z.number().int().min(0).max(3).optional(),
        contextAfter: z.number().int().min(0).max(3).optional(),
        maxChars: z.number().int().min(1000).max(24000).optional(),
      }),
      outputSchema: z.object({
        targetKind: z.enum(["document", "chunk"]),
        documentId: z.string(),
        requestedChunkId: z.string().optional(),
        title: z.string(),
        path: z.string(),
        kind: z.string(),
        category: z.string(),
        language: z.string(),
        sourceId: z.string(),
        sourceName: z.string(),
        sourceTier: z.number().int(),
        channel: z.string(),
        stability: z.string(),
        lifecycle: z.string(),
        chunks: z.array(z.object({
          chunkId: z.string(),
          ordinal: z.number().int(),
          title: z.string(),
          identifier: z.string().optional(),
          chunkType: z.string(),
          content: z.string(),
          startLine: z.number().int(),
          endLine: z.number().int(),
          jsonPointer: z.string().optional(),
          stability: z.string(),
          lifecycle: z.string(),
        })),
        truncated: z.boolean(),
        totalChars: z.number().int(),
        ...provenanceShape,
      }),
    },
    async (args) => {
      try {
        return textResult(fetchKnowledge(requireDatabase(database), args));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "get_definition",
    {
      title: "Get Bedrock definition",
      description: "Look up an exact Bedrock component or Script API identifier. Returns at most three definitions and prefers current stable material.",
      annotations: READ_ONLY,
      inputSchema: z.object({
        identifier: z.string().trim().min(1).max(250),
        minecraftVersion: z.string().min(1).max(50).optional(),
        includePreview: z.boolean().optional(),
        includeHistorical: z.boolean().optional(),
      }),
      outputSchema: z.object({
        identifier: z.string(),
        definitions: z.array(definitionSchema).max(3),
        stableDefinitionFound: z.boolean(),
        warning: z.string().optional(),
      }),
    },
    async (args) => {
      try {
        return textResult(getDefinition(requireDatabase(database), args));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "list_sources",
    {
      title: "List knowledge sources",
      description: "List indexed knowledge sources with trust tier, release channel, revision, and indexed document/chunk counts.",
      annotations: READ_ONLY,
      inputSchema: z.object({}),
      outputSchema: z.object({
        sources: z.array(z.object({
          id: z.string(),
          name: z.string(),
          type: z.string(),
          tier: z.number().int(),
          channel: z.string(),
          enabled: z.boolean(),
          documents: z.number().int(),
          chunks: z.number().int(),
          repository: z.string().optional(),
          branch: z.string().optional(),
          revision: z.string().optional(),
          lastIndexedAt: z.string().optional(),
        })),
      }),
    },
    async () => {
      try {
        return textResult({ sources: listKnowledgeSources(requireDatabase(database)) });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "list_categories",
    {
      title: "List knowledge categories",
      description: "List categories currently present in the Bedrock knowledge index with document and chunk counts.",
      annotations: READ_ONLY,
      inputSchema: z.object({}),
      outputSchema: z.object({
        categories: z.array(z.object({ id: z.string(), documents: z.number().int(), chunks: z.number().int() })),
      }),
    },
    async () => {
      try {
        return textResult({ categories: listKnowledgeCategories(requireDatabase(database)) });
      } catch (error) {
        return toolError(error);
      }
    },
  );
}
