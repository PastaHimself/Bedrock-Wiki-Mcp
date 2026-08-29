import type { DatabaseSync } from "node:sqlite";
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { answerBedrock } from "../ai/answer.js";
import type { LocalLlm } from "../ai/local-llm.js";
import type { SemanticRetriever } from "../semantic/retriever.js";
import { getDefinition } from "../search/definition.js";
import { listKnowledgeCategories, listKnowledgeSources } from "../search/discovery.js";
import { searchKnowledge, type KnowledgeSearchOptions } from "../search/engine.js";
import { fetchKnowledge } from "../search/fetch.js";
import { hybridSearchKnowledge } from "../search/hybrid.js";

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const kindSchema = z.enum(["docs", "api", "component", "json", "code", "example", "reference"]);
const stabilitySchema = z.enum(["stable", "beta", "experimental", "internal", "unknown"]);
const channelSchema = z.enum(["stable", "preview", "unknown"]);

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
  sourceType: z.string(),
  sourceTier: z.number().int(),
  score: z.number(),
  exactMatch: z.boolean(),
  mergedChunkIds: z.array(z.string()).max(2).optional(),
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
  sourceType: z.string(),
  sourceTier: z.number().int(),
  isPrimary: z.boolean(),
  ...provenanceShape,
});

const definitionExampleSchema = z.object({
  chunkId: z.string(),
  documentId: z.string(),
  title: z.string(),
  content: z.string(),
  path: z.string(),
  channel: z.string(),
  sourceId: z.string(),
  sourceName: z.string(),
  sourceTier: z.number().int(),
  repository: z.string().optional(),
  revision: z.string().optional(),
  canonicalUrl: z.string().optional(),
  apiPackage: z.string().optional(),
  apiVersion: z.string().optional(),
  minecraftVersion: z.string().optional(),
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

export function registerKnowledgeTools(
  server: McpServer,
  database?: DatabaseSync,
  semantic?: SemanticRetriever,
  semanticTopK = 40,
  localLlm?: LocalLlm,
  localLlmRetrievalLimit = 6,
): void {
  server.registerTool(
    "search",
    {
      title: "Search Bedrock knowledge",
      description: "Search indexed Minecraft Bedrock documentation, Script API definitions, JSON, code, and official module metadata. Exact identifiers receive dominant relevance; developer intent, stable/preview status, provenance, and optional semantic retrieval refine ranking.",
      annotations: READ_ONLY,
      inputSchema: z.object({
        query: z.string().trim().min(1).max(500).describe("Exact Bedrock identifier or natural-language developer question"),
        limit: z.number().int().min(1).max(10).optional(),
        kinds: z.array(kindSchema).max(10).optional(),
        categories: z.array(z.string().min(1).max(100)).max(10).optional(),
        stabilities: z.array(stabilitySchema).max(5).optional(),
        sourceTiers: z.array(z.number().int().min(1).max(4)).max(4).optional(),
        source: z.string().trim().min(1).max(100).optional().describe("Exact indexed source id from list_sources"),
        channel: channelSchema.optional().describe("Restrict results to stable, preview, or unknown source channel"),
        module: z.string().trim().min(1).max(100).optional().describe("Exact Script API package/module name, for example @minecraft/server"),
        pathPrefix: z.string().trim().min(1).max(500).optional().describe("Restrict results to indexed source paths beginning with this prefix"),
        minecraftVersion: z.string().min(1).max(50).optional(),
        apiVersion: z.string().min(1).max(50).optional(),
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
        const options: KnowledgeSearchOptions = {
          query: args.query,
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
          ...(args.kinds !== undefined ? { kinds: args.kinds } : {}),
          ...(args.categories !== undefined ? { categories: args.categories } : {}),
          ...(args.stabilities !== undefined ? { stabilities: args.stabilities } : {}),
          ...(args.sourceTiers !== undefined ? { sourceTiers: args.sourceTiers } : {}),
          ...(args.source !== undefined ? { sourceId: args.source } : {}),
          ...(args.channel !== undefined ? { channel: args.channel } : {}),
          ...(args.module !== undefined ? { apiPackage: args.module } : {}),
          ...(args.pathPrefix !== undefined ? { pathPrefix: args.pathPrefix } : {}),
          ...(args.minecraftVersion !== undefined ? { minecraftVersion: args.minecraftVersion } : {}),
          ...(args.apiVersion !== undefined ? { apiVersion: args.apiVersion } : {}),
          ...(args.includePreview !== undefined ? { includePreview: args.includePreview } : {}),
          ...(args.includeHistorical !== undefined ? { includeHistorical: args.includeHistorical } : {}),
          ...(args.maxChars !== undefined ? { maxChars: args.maxChars } : {}),
        };
        const db = requireDatabase(database);
        return textResult(semantic
          ? await hybridSearchKnowledge(db, semantic, options, semanticTopK)
          : searchKnowledge(db, options));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "fetch",
    {
      title: "Fetch Bedrock evidence",
      description: "Fetch a document or chunk returned by search using only server-issued doc_* or chk_* IDs. Chunk fetches can return adjacent chunks or the surrounding heading section. Arbitrary filesystem paths are never accepted.",
      annotations: READ_ONLY,
      inputSchema: z.object({
        id: z.string().min(1).max(64),
        contextMode: z.enum(["adjacent", "section"]).optional(),
        contextBefore: z.number().int().min(0).max(3).optional(),
        contextAfter: z.number().int().min(0).max(3).optional(),
        maxChars: z.number().int().min(1000).max(24000).optional(),
      }),
      outputSchema: z.object({
        targetKind: z.enum(["document", "chunk"]),
        contextMode: z.enum(["adjacent", "section"]),
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
          headingPath: z.array(z.string()),
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
        return textResult(fetchKnowledge(requireDatabase(database), {
          id: args.id,
          ...(args.contextMode !== undefined ? { contextMode: args.contextMode } : {}),
          ...(args.contextBefore !== undefined ? { contextBefore: args.contextBefore } : {}),
          ...(args.contextAfter !== undefined ? { contextAfter: args.contextAfter } : {}),
          ...(args.maxChars !== undefined ? { maxChars: args.maxChars } : {}),
        }));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "get_definition",
    {
      title: "Get Bedrock definition",
      description: "Look up an exact Bedrock component or Script API identifier. Returns at most three version-aware definitions plus up to two relevant code/example chunks when indexed.",
      annotations: READ_ONLY,
      inputSchema: z.object({
        identifier: z.string().trim().min(1).max(250),
        minecraftVersion: z.string().min(1).max(50).optional(),
        apiVersion: z.string().min(1).max(50).optional(),
        includePreview: z.boolean().optional(),
        includeHistorical: z.boolean().optional(),
      }),
      outputSchema: z.object({
        identifier: z.string(),
        definitions: z.array(definitionSchema).max(3),
        examples: z.array(definitionExampleSchema).max(2),
        stableDefinitionFound: z.boolean(),
        warning: z.string().optional(),
      }),
    },
    async (args) => {
      try {
        return textResult(getDefinition(requireDatabase(database), {
          identifier: args.identifier,
          ...(args.minecraftVersion !== undefined ? { minecraftVersion: args.minecraftVersion } : {}),
          ...(args.apiVersion !== undefined ? { apiVersion: args.apiVersion } : {}),
          ...(args.includePreview !== undefined ? { includePreview: args.includePreview } : {}),
          ...(args.includeHistorical !== undefined ? { includeHistorical: args.includeHistorical } : {}),
        }));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "list_sources",
    {
      title: "List knowledge sources",
      description: "List indexed knowledge sources with trust tier, release channel, revision, last indexing time, empty-source health, and exact duplicate chunk percentage.",
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
          health: z.enum(["healthy", "empty"]),
          documents: z.number().int(),
          chunks: z.number().int(),
          duplicateChunks: z.number().int(),
          duplicatePercent: z.number(),
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
      description: "List controlled Bedrock development categories currently present in the index with document and chunk counts.",
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

  server.registerTool(
    "ask_bedrock",
    {
      title: "Ask the local Bedrock helper",
      description: "Answer a Minecraft Bedrock development question with an optional local Qwen model grounded in indexed documentation. Returns the exact resources and citations used; it never calls a hosted AI service.",
      annotations: READ_ONLY,
      inputSchema: z.object({
        query: z.string().trim().min(1).max(500).describe("Bedrock development question to answer from indexed evidence"),
        limit: z.number().int().min(1).max(8).optional().describe("Maximum indexed resources to give the local model"),
        kinds: z.array(kindSchema).max(10).optional(),
        categories: z.array(z.string().min(1).max(100)).max(10).optional(),
        stabilities: z.array(stabilitySchema).max(5).optional(),
        sourceTiers: z.array(z.number().int().min(1).max(4)).max(4).optional(),
        source: z.string().trim().min(1).max(100).optional().describe("Exact indexed source id from list_sources"),
        channel: channelSchema.optional(),
        module: z.string().trim().min(1).max(100).optional().describe("Exact Script API package/module name, for example @minecraft/server"),
        pathPrefix: z.string().trim().min(1).max(500).optional(),
        minecraftVersion: z.string().min(1).max(50).optional(),
        apiVersion: z.string().min(1).max(50).optional(),
        includePreview: z.boolean().optional(),
        includeHistorical: z.boolean().optional(),
      }),
      outputSchema: z.object({
        query: z.string(),
        answer: z.string(),
        model: z.string(),
        resources: z.array(searchResultSchema).max(8),
        citations: z.array(z.object({
          id: z.string(),
          chunkId: z.string(),
          documentId: z.string(),
          title: z.string(),
          path: z.string(),
          sourceId: z.string(),
          sourceName: z.string(),
          channel: z.string(),
          sourceTier: z.number().int(),
          canonicalUrl: z.string().optional(),
        })).max(8),
        candidateCount: z.number().int(),
        grounded: z.boolean(),
        warning: z.string().optional(),
      }),
    },
    async (args) => {
      try {
        if (!localLlm) {
          throw new Error("LOCAL_LLM_DISABLED: set BEDROCK_MCP_LOCAL_LLM_ENABLED=true; llama-server is started and the model is downloaded automatically when the server starts");
        }
        const options: KnowledgeSearchOptions = {
          query: args.query,
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
          ...(args.kinds !== undefined ? { kinds: args.kinds } : {}),
          ...(args.categories !== undefined ? { categories: args.categories } : {}),
          ...(args.stabilities !== undefined ? { stabilities: args.stabilities } : {}),
          ...(args.sourceTiers !== undefined ? { sourceTiers: args.sourceTiers } : {}),
          ...(args.source !== undefined ? { sourceId: args.source } : {}),
          ...(args.channel !== undefined ? { channel: args.channel } : {}),
          ...(args.module !== undefined ? { apiPackage: args.module } : {}),
          ...(args.pathPrefix !== undefined ? { pathPrefix: args.pathPrefix } : {}),
          ...(args.minecraftVersion !== undefined ? { minecraftVersion: args.minecraftVersion } : {}),
          ...(args.apiVersion !== undefined ? { apiVersion: args.apiVersion } : {}),
          ...(args.includePreview !== undefined ? { includePreview: args.includePreview } : {}),
          ...(args.includeHistorical !== undefined ? { includeHistorical: args.includeHistorical } : {}),
        };
        const db = requireDatabase(database);
        return textResult(await answerBedrock({
          llm: localLlm,
          retrievalLimit: localLlmRetrievalLimit,
          search: (searchOptions) => semantic
            ? hybridSearchKnowledge(db, semantic, searchOptions, semanticTopK)
            : searchKnowledge(db, searchOptions),
        }, options));
      } catch (error) {
        return toolError(error);
      }
    },
  );
}
