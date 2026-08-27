import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod/v4";
import { normalizeIdentifier } from "../identifiers/normalize.js";
import { searchKnowledge, type KnowledgeSearchResult } from "../search/engine.js";

const relevanceSchema = z.object({
  identifier: z.string().trim().min(1).max(300),
  grade: z.number().int().min(1).max(3).default(3),
});

const benchmarkCaseSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
  kind: z.enum(["exact", "natural"]),
  query: z.string().trim().min(1).max(500),
  relevant: z.array(relevanceSchema).min(1).max(20),
  includePreview: z.boolean().optional(),
  includeHistorical: z.boolean().optional(),
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

export interface BenchmarkCaseResult {
  id: string;
  kind: "exact" | "natural";
  query: string;
  reciprocalRank: number;
  recallAt3: number;
  recallAt5: number;
  ndcgAt5: number;
  firstRelevantRank?: number;
  topIdentifiers: string[];
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

function dcg(grades: readonly number[]): number {
  return grades.reduce((sum, grade, index) => sum + (2 ** grade - 1) / Math.log2(index + 2), 0);
}

export function evaluateBenchmarkCase(
  benchmark: BenchmarkSuite["queries"][number],
  results: readonly KnowledgeSearchResult[],
): BenchmarkCaseResult {
  const relevant = new Map(
    benchmark.relevant.map((entry) => [normalizeIdentifier(entry.identifier), entry.grade]),
  );
  let firstRelevantRank: number | undefined;
  for (const [index, result] of results.entries()) {
    const identifier = resultIdentifier(result);
    if (identifier && relevant.has(identifier)) {
      firstRelevantRank = index + 1;
      break;
    }
  }

  const seenForDcg = new Set<string>();
  const rankedGrades = results.slice(0, 5).map((result) => {
    const identifier = resultIdentifier(result);
    if (!identifier || seenForDcg.has(identifier)) return 0;
    seenForDcg.add(identifier);
    return relevant.get(identifier) ?? 0;
  });

  const recallAt = (limit: number): number => {
    const identifiers = new Set(
      results.slice(0, limit).map(resultIdentifier).filter((value): value is string => Boolean(value)),
    );
    let found = 0;
    for (const identifier of relevant.keys()) {
      if (identifiers.has(identifier)) found += 1;
    }
    return found / relevant.size;
  };
  const idealGrades = [...relevant.values()].sort((a, b) => b - a).slice(0, 5);
  const idealDcg = dcg(idealGrades);

  return {
    id: benchmark.id,
    kind: benchmark.kind,
    query: benchmark.query,
    reciprocalRank: firstRelevantRank ? round(1 / firstRelevantRank) : 0,
    recallAt3: round(recallAt(3)),
    recallAt5: round(recallAt(5)),
    ndcgAt5: round(idealDcg > 0 ? dcg(rankedGrades) / idealDcg : 0),
    ...(firstRelevantRank !== undefined ? { firstRelevantRank } : {}),
    topIdentifiers: results.slice(0, 5).map((result) => result.identifier ?? "").filter(Boolean),
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
  const passedTargets = exactTop1 >= suite.targets.exactTop1
    && naturalTop3 >= suite.targets.naturalTop3
    && usefulTop5 >= suite.targets.usefulTop5;

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
    `Quality gate: ${summary.passedTargets ? "PASS" : "FAIL"}`,
  ];
  for (const entry of summary.cases.filter((item) => entryNeedsAttention(item))) {
    lines.push(`  ${entry.id}: first relevant ${entry.firstRelevantRank ?? "none"}; top=${entry.topIdentifiers.join(", ") || "(no identifiers)"}`);
  }
  return `${lines.join("\n")}\n`;
}

function entryNeedsAttention(entry: BenchmarkCaseResult): boolean {
  return entry.firstRelevantRank === undefined || entry.firstRelevantRank > 3;
}
