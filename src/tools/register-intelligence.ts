import type { DatabaseSync } from "node:sqlite";
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { SemanticRetriever } from "../semantic/retriever.js";
import { getDefinition } from "../search/definition.js";
import { searchKnowledge, type KnowledgeSearchOptions } from "../search/engine.js";
import { hybridSearchKnowledge } from "../search/hybrid.js";
import { planBedrockQuery } from "../search/query-helper.js";
import { resolveRelationships } from "../search/relationships.js";
import { compareIdentifierVersions } from "../search/version-compare.js";

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const provenanceShape = {
  repository: z.string().optional(),
  revision: z.string().optional(),
  canonicalUrl: z.string().optional(),
  apiPackage: z.string().optional(),
  apiVersion: z.string().optional(),
  minecraftVersion: z.string().optional(),
};

const exampleSchema = z.object({
  chunkId: z.string(),
  documentId: z.string(),
  title: z.string(),
  content: z.string(),
  path: z.string(),
  channel: z.string(),
  sourceId: z.string(),
  sourceName: z.string(),
  sourceTier: z.number().int(),
  ...provenanceShape,
});

const versionSnapshotSchema = z.object({
  requestedVersion: z.string(),
  identifier: z.string(),
  chunkId: z.string(),
  documentId: z.string(),
  title: z.string(),
  content: z.string(),
  contentHash: z.string(),
  symbolKind: z.string().optional(),
  path: z.string(),
  kind: z.string(),
  category: z.string(),
  stability: z.string(),
  lifecycle: z.string(),
  channel: z.string(),
  sourceId: z.string(),
  sourceName: z.string(),
  sourceTier: z.number().int(),
  ...provenanceShape,
});

const relationshipSchema = z.object({
  depth: z.number().int(),
  direction: z.enum(["outgoing", "incoming"]),
  fromIdentifier: z.string(),
  relation: z.string(),
  toIdentifier: z.string(),
  sourceChunkId: z.string().optional(),
  sourceDocumentId: z.string().optional(),
  sourcePath: z.string().optional(),
  sourceId: z.string().optional(),
  sourceName: z.string().optional(),
  sourceTier: z.number().int().optional(),
  channel: z.string().optional(),
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

interface ExampleOutput {
  chunkId: string;
  documentId: string;
  title: string;
  content: string;
  path: string;
  channel: string;
  sourceId: string;
  sourceName: string;
  sourceTier: number;
  repository?: string;
  revision?: string;
  canonicalUrl?: string;
  apiPackage?: string;
  apiVersion?: string;
  minecraftVersion?: string;
}

export function registerIntelligenceTools(
  server: McpServer,
  database?: DatabaseSync,
  semantic?: SemanticRetriever,
  semanticTopK = 40,
): void {
  server.registerTool(
    "find_examples",
    {
      title: "Find Bedrock examples",
      description: "Find code/example evidence for a Bedrock identifier or developer question. Exact identifiers use symbol-linked examples first, followed by ranked example/code retrieval.",
      annotations: READ_ONLY,
      inputSchema: z.object({
        query: z.string().trim().min(1).max(500),
        limit: z.number().int().min(1).max(10).optional(),
        module: z.string().trim().min(1).max(100).optional(),
        apiVersion: z.string().trim().min(1).max(50).optional(),
        minecraftVersion: z.string().trim().min(1).max(50).optional(),
        includePreview: z.boolean().optional(),
        includeHistorical: z.boolean().optional(),
      }),
      outputSchema: z.object({
        query: z.string(),
        identifier: z.string().optional(),
        examples: z.array(exampleSchema).max(10),
        truncated: z.boolean(),
      }),
    },
    async (args) => {
      try {
        const db = requireDatabase(database);
        const helper = planBedrockQuery(args.query);
        const identifier = helper.identifiers[0];
        const limit = args.limit ?? 5;
        const examples: ExampleOutput[] = [];
        const seen = new Set<string>();

        if (identifier) {
          const exact = getDefinition(db, {
            identifier,
            ...(args.apiVersion ? { apiVersion: args.apiVersion } : {}),
            ...(args.minecraftVersion ? { minecraftVersion: args.minecraftVersion } : {}),
            ...((args.includePreview ?? helper.includePreview) !== undefined
              ? { includePreview: args.includePreview ?? helper.includePreview }
              : {}),
            ...(args.includeHistorical !== undefined ? { includeHistorical: args.includeHistorical } : {}),
          });
          for (const example of exact.examples) {
            if (examples.length >= limit || seen.has(example.chunkId)) continue;
            seen.add(example.chunkId);
            examples.push(example);
          }
        }

        if (examples.length < limit) {
          const options: KnowledgeSearchOptions = {
            query: helper.intent === "example" ? args.query : `${args.query} example`,
            limit: 10,
            kinds: ["example", "code"],
            maxChars: 24_000,
            ...((args.module ?? helper.module) ? { apiPackage: args.module ?? helper.module } : {}),
            ...(args.apiVersion ? { apiVersion: args.apiVersion } : {}),
            ...(args.minecraftVersion ? { minecraftVersion: args.minecraftVersion } : {}),
            ...((args.includePreview ?? helper.includePreview) !== undefined
              ? { includePreview: args.includePreview ?? helper.includePreview }
              : {}),
            ...(args.includeHistorical !== undefined ? { includeHistorical: args.includeHistorical } : {}),
          };
          const ranked = semantic
            ? await hybridSearchKnowledge(db, semantic, options, semanticTopK)
            : searchKnowledge(db, options);
          for (const result of ranked.results) {
            if (examples.length >= limit || seen.has(result.chunkId)) continue;
            seen.add(result.chunkId);
            examples.push({
              chunkId: result.chunkId,
              documentId: result.documentId,
              title: result.title,
              content: result.excerpt,
              path: result.path,
              channel: result.channel,
              sourceId: result.sourceId,
              sourceName: result.sourceName,
              sourceTier: result.sourceTier,
              ...(result.repository ? { repository: result.repository } : {}),
              ...(result.revision ? { revision: result.revision } : {}),
              ...(result.canonicalUrl ? { canonicalUrl: result.canonicalUrl } : {}),
              ...(result.apiPackage ? { apiPackage: result.apiPackage } : {}),
              ...(result.apiVersion ? { apiVersion: result.apiVersion } : {}),
              ...(result.minecraftVersion ? { minecraftVersion: result.minecraftVersion } : {}),
            });
          }
        }

        return textResult({
          query: args.query,
          ...(identifier ? { identifier } : {}),
          examples,
          truncated: examples.length >= limit,
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "compare_versions",
    {
      title: "Compare Bedrock versions",
      description: "Compare the best indexed definition for one exact Bedrock identifier between two API or Minecraft versions. The result reports added, removed, changed, unchanged, or not-found status with source evidence.",
      annotations: READ_ONLY,
      inputSchema: z.object({
        identifier: z.string().trim().min(1).max(250),
        versionKind: z.enum(["api", "minecraft"]),
        fromVersion: z.string().trim().min(1).max(100),
        toVersion: z.string().trim().min(1).max(100),
        includePreview: z.boolean().optional(),
      }),
      outputSchema: z.object({
        requestedIdentifier: z.string(),
        normalizedIdentifier: z.string(),
        versionKind: z.enum(["api", "minecraft"]),
        fromVersion: z.string(),
        toVersion: z.string(),
        status: z.enum(["added", "removed", "changed", "unchanged", "not_found"]),
        from: versionSnapshotSchema.optional(),
        to: versionSnapshotSchema.optional(),
        changes: z.object({
          content: z.boolean(),
          stability: z.boolean(),
          lifecycle: z.boolean(),
          symbolKind: z.boolean(),
        }),
        warning: z.string().optional(),
      }),
    },
    async (args) => {
      try {
        return textResult(compareIdentifierVersions(requireDatabase(database), {
          identifier: args.identifier,
          versionKind: args.versionKind,
          fromVersion: args.fromVersion,
          toVersion: args.toVersion,
          ...(args.includePreview !== undefined ? { includePreview: args.includePreview } : {}),
        }));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "resolve_relationships",
    {
      title: "Resolve Bedrock relationships",
      description: "Traverse deterministic symbol relationships derived from indexed Bedrock evidence, including runtime aliases and Script API property-type links.",
      annotations: READ_ONLY,
      inputSchema: z.object({
        identifier: z.string().trim().min(1).max(250),
        relation: z.string().trim().min(1).max(80).optional(),
        depth: z.number().int().min(1).max(3).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      }),
      outputSchema: z.object({
        requestedIdentifier: z.string(),
        normalizedIdentifier: z.string(),
        canonicalIdentifiers: z.array(z.string()).max(16),
        relationships: z.array(relationshipSchema).max(100),
        truncated: z.boolean(),
      }),
    },
    async (args) => {
      try {
        return textResult(resolveRelationships(requireDatabase(database), {
          identifier: args.identifier,
          ...(args.relation !== undefined ? { relation: args.relation } : {}),
          ...(args.depth !== undefined ? { depth: args.depth } : {}),
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
        }));
      } catch (error) {
        return toolError(error);
      }
    },
  );
}
