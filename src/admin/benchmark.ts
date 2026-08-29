import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod/v4";
import { normalizeIdentifier } from "../identifiers/normalize.js";
import { searchKnowledge, type KnowledgeSearchResult } from "../search/engine.js";

const relevanceSchema = z.object({
  identifier: z.string().trim().min(1).max(300).optional(),
  source: z.string().trim().min(1).max(100).optional(),
  category: z.string().trim().min(1).max(100).optional(),
  channel: z.enum(["stable", "preview", "unknown"]).optional(),
  module: z.string().trim().min(1).max(100).optional(),
  pathContains: z.string().trim().min(1).max(300).optional(),
  grade: z.number().int().min(1).max(3).default(3),
}).refine(
  (entry) => Boolean(entry.identifier || entry.source || entry.category || entry.channel || entry.module || entry.pathContains),
  "benchmark relevance entry must constrain at least one result field",
);

const benchmarkCaseSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
  kind: z.enum(["exact", "natural"]),
  query: z.string().trim().min(1).max(500),
  relevant: z.array(relevanceSchema).min(1).max(20),
  requiredTopK: z.number().int().min(1).max(10).optional(),
  includePreview: z.boolean().optional(),
  includeHistorical: z.boolean().optional(),
  source: z.string().trim().min(1).max(100).optional(),
  channel: z.enum(["stable", "preview", "unknown"]).optional(),
  module: z.string().trim().min(1).max(100).optional(),
  pathPrefix: z.string().trim().min(1).max(500).optional(),
  categories: z.array(z.string().trim().min(1).max(100)).max(10).optional(),
  apiVersion: z.string().trim().min(1).max(50).optional(),
  minecraftVersion: z.string().trim().min(1).max(50).optional(),
});

const targetsSchema = z.object({
  exactTop1: z.number().min(0).max(1).default(0.95),
  naturalTop3: z.number().min(0).max(1).default(0.90),
  usefulTop5: z.number().min(0).max(1).default(0.95),
}).default({ exactTop1: 0.95, naturalTop3: 0.90, usefulTop5: 0.95 });

const suiteSchema = z.object({
  name: z.string().trim().min(1).max(200),
  targets: targetsSchema,
  queries: z.array(benchmarkCaseSchema).min(1).max(500),
});

export type BenchmarkSuite = z.infer<typeof suiteSchema>;
type BenchmarkCase = BenchmarkSuite["queries"][number];
type BenchmarkRelevance = BenchmarkCase["relevant"][number];

export interface BenchmarkCaseResult {
  id: string;
  kind: "exact" | "natural";
  query: string;
  reciprocalRank: number;
  recallAt3: number;
  recallAt5: number;
  ndcgAt5: number;
  firstRelevantRank?: number;
  requiredTopK?: number;
  requiredPassed: boolean;
  topIdentifiers: string[];
  topResults: string[];
}

export interface BenchmarkSummary {
  suite: string;
  queries: number;
  mrr: number;
  recallAt3: number;
  recallAt5: number;
  ndcgAt5: number;
  exactTop1: number;
  naturalTop3: number;
  usefulTop5: number;
  requiredCases: number;
  requiredCasesPassed: number;
  requiredGatePassed: boolean;
  targets: BenchmarkSuite["targets"];
  passedTargets: boolean;
  cases: BenchmarkCaseResult[];
}

function round(value: number): number {
  return Number(value.toFixed(4));
}

function average(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function resultIdentifier(result: KnowledgeSearchResult): string | undefined {
  return result.identifier ? normalizeIdentifier(result.identifier) : undefined;
}

function normalizedOptional(value: string | undefined): string | undefined {
  return value?.toLocaleLowerCase("en-US");
}

function relevanceKey(relevance: BenchmarkRelevance): string {
  return JSON.stringify({
    identifier: relevance.identifier ? normalizeIdentifier(relevance.identifier) : null,
    source: relevance.source ?? null,
    category: relevance.category ?? null,
    channel: relevance.channel ?? null,
    module: normalizedOptional(relevance.module) ?? null,
    pathContains: normalizedOptional(relevance.pathContains) ?? null,
  });
}

function matchesRelevance(result: KnowledgeSearchResult, relevance: BenchmarkRelevance): boolean {
  if (relevance.identifier && resultIdentifier(result) !== normalizeIdentifier(relevance.identifier)) return false;
  if (relevance.source && result.sourceId !== relevance.source) return false;
  if (relevance.category && result.category !== relevance.category) return false;
  if (relevance.channel && result.channel !== relevance.channel) return false;
  if (relevance.module && normalizedOptional(result.apiPackage) !== normalizedOptional(relevance.module)) return false;
  if (relevance.pathContains && !result.path.toLocaleLowerCase("en-US").includes(relevance.pathContains.toLocaleLowerCase("en-US"))) return false;
  return true;
}

function matchingRelevant(result: KnowledgeSearchResult, relevant: readonly BenchmarkRelevance[]): BenchmarkRelevance[] {
  return relevant.filter((entry) => matchesRelevance(result, entry));
}

function dcg(grades: readonly number[]): number {
  return grades.reduce((sum, grade, index) => sum + (2 ** grade - 1) / Math.log2(index + 2), 0);
}

function topResultLabel(result: KnowledgeSearchResult): string {
  const identity = result.identifier ?? result.title;
  const version = result.apiVersion ? `@${result.apiVersion}` : "";
  return `${identity}${version} [${result.sourceId}/${result.channel}/${result.category}]`;
}

export function evaluateBenchmarkCase(
  benchmark: BenchmarkCase,
  results: readonly KnowledgeSearchResult[],
): BenchmarkCaseResult {
  let firstRelevantRank: number | undefined;
  for (const [index, result] of results.entries()) {
    if (matchingRelevant(result, benchmark.relevant).length > 0) {
      firstRelevantRank = index + 1;
      break;
    }
  }

  const seenForDcg = new Set<string>();
  const rankedGrades = results.slice(0, 5).map((result) => {
    const matches = matchingRelevant(result, benchmark.relevant)
      .filter((entry) => !seenForDcg.has(relevanceKey(entry)));
    if (matches.length === 0) return 0;
    for (const match of matches) seenForDcg.add(relevanceKey(match));
    return Math.max(...matches.map((entry) => entry.grade));
  });

  const recallAt = (limit: number): number => {
    const matched = new Set<string>();
    for (const result of results.slice(0, limit)) {
      for (const entry of matchingRelevant(result, benchmark.relevant)) matched.add(relevanceKey(entry));
    }
    return matched.size / benchmark.relevant.length;
  };

  const idealGrades = benchmark.relevant.map((entry) => entry.grade).sort((a, b) => b - a).slice(0, 5);
  const idealDcg = dcg(idealGrades);
  const requiredPassed = benchmark.requiredTopK === undefined
    || (firstRelevantRank !== undefined && firstRelevantRank <= benchmark.requiredTopK);

  return {
    id: benchmark.id,
    kind: benchmark.kind,
    query: benchmark.query,
    reciprocalRank: firstRelevantRank ? round(1 / firstRelevantRank) : 0,
    recallAt3: round(recallAt(3)),
    recallAt5: round(recallAt(5)),
    ndcgAt5: round(idealDcg > 0 ? dcg(rankedGrades) / idealDcg : 0),
    ...(firstRelevantRank !== undefined ? { firstRelevantRank } : {}),
    ...(benchmark.requiredTopK !== undefined ? { requiredTopK: benchmark.requiredTopK } : {}),
    requiredPassed,
    topIdentifiers: results.slice(0, 5).map((result) => result.identifier ?? "").filter(Boolean),
    topResults: results.slice(0, 5).map(topResultLabel),
  };
}

export async function loadBenchmarkSuite(path: string): Promise<BenchmarkSuite> {
  const raw = JSON.parse(await readFile(resolve(path), "utf8")) as unknown;
  return suiteSchema.parse(raw);
}

export function runBenchmark(database: DatabaseSync, suite: BenchmarkSuite): BenchmarkSummary {
  const cases = suite.queries.map((benchmark) => {
    const response = searchKnowledge(database, {
      query: benchmark.query,
      limit: 10,
      maxChars: 24_000,
      ...(benchmark.includePreview !== undefined ? { includePreview: benchmark.includePreview } : {}),
      ...(benchmark.includeHistorical !== undefined ? { includeHistorical: benchmark.includeHistorical } : {}),
      ...(benchmark.source !== undefined ? { sourceId: benchmark.source } : {}),
      ...(benchmark.channel !== undefined ? { channel: benchmark.channel } : {}),
      ...(benchmark.module !== undefined ? { apiPackage: benchmark.module } : {}),
      ...(benchmark.pathPrefix !== undefined ? { pathPrefix: benchmark.pathPrefix } : {}),
      ...(benchmark.categories !== undefined ? { categories: benchmark.categories } : {}),
      ...(benchmark.apiVersion !== undefined ? { apiVersion: benchmark.apiVersion } : {}),
      ...(benchmark.minecraftVersion !== undefined ? { minecraftVersion: benchmark.minecraftVersion } : {}),
    });
    return evaluateBenchmarkCase(benchmark, response.results);
  });

  const exact = cases.filter((entry) => entry.kind === "exact");
  const natural = cases.filter((entry) => entry.kind === "natural");
  const exactTop1 = exact.length > 0 ? average(exact.map((entry) => Number(entry.firstRelevantRank === 1))) : 1;
  const naturalTop3 = natural.length > 0
    ? average(natural.map((entry) => Number((entry.firstRelevantRank ?? Infinity) <= 3)))
    : 1;
  const usefulTop5 = average(cases.map((entry) => Number((entry.firstRelevantRank ?? Infinity) <= 5)));
  const mrr = average(cases.map((entry) => entry.reciprocalRank));
  const recallAt3 = average(cases.map((entry) => entry.recallAt3));
  const recallAt5 = average(cases.map((entry) => entry.recallAt5));
  const ndcgAt5 = average(cases.map((entry) => entry.ndcgAt5));
  const required = cases.filter((entry) => entry.requiredTopK !== undefined);
  const requiredCasesPassed = required.filter((entry) => entry.requiredPassed).length;
  const requiredGatePassed = requiredCasesPassed === required.length;
  const passedTargets = exactTop1 >= suite.targets.exactTop1
    && naturalTop3 >= suite.targets.naturalTop3
    && usefulTop5 >= suite.targets.usefulTop5
    && requiredGatePassed;

  return {
    suite: suite.name,
    queries: cases.length,
    mrr: round(mrr),
    recallAt3: round(recallAt3),
    recallAt5: round(recallAt5),
    ndcgAt5: round(ndcgAt5),
    exactTop1: round(exactTop1),
    naturalTop3: round(naturalTop3),
    usefulTop5: round(usefulTop5),
    requiredCases: required.length,
    requiredCasesPassed,
    requiredGatePassed,
    targets: suite.targets,
    passedTargets,
    cases,
  };
}

export function formatBenchmarkSummary(summary: BenchmarkSummary): string {
  const lines = [
    `Benchmark: ${summary.suite} (${summary.queries} queries)`,
    `MRR: ${summary.mrr.toFixed(4)}`,
    `Recall@3: ${summary.recallAt3.toFixed(4)}`,
    `Recall@5: ${summary.recallAt5.toFixed(4)}`,
    `NDCG@5: ${summary.ndcgAt5.toFixed(4)}`,
    `Exact Top-1: ${summary.exactTop1.toFixed(4)} (target ${summary.targets.exactTop1.toFixed(2)})`,
    `Natural Top-3: ${summary.naturalTop3.toFixed(4)} (target ${summary.targets.naturalTop3.toFixed(2)})`,
    `Useful Top-5: ${summary.usefulTop5.toFixed(4)} (target ${summary.targets.usefulTop5.toFixed(2)})`,
    `Required cases: ${summary.requiredCasesPassed}/${summary.requiredCases} (${summary.requiredGatePassed ? "PASS" : "FAIL"})`,
    `Quality gate: ${summary.passedTargets ? "PASS" : "FAIL"}`,
  ];
  for (const entry of summary.cases.filter((item) => entryNeedsAttention(item))) {
    const requirement = entry.requiredTopK !== undefined ? `; required<=${entry.requiredTopK} ${entry.requiredPassed ? "PASS" : "FAIL"}` : "";
    lines.push(`  ${entry.id}: first relevant ${entry.firstRelevantRank ?? "none"}${requirement}; top=${entry.topResults.join(" | ") || "(no results)"}`);
  }
  return `${lines.join("\n")}\n`;
}

function entryNeedsAttention(entry: BenchmarkCaseResult): boolean {
  return !entry.requiredPassed || entry.firstRelevantRank === undefined || entry.firstRelevantRank > 3;
}
