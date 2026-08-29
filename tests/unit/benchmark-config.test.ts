import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadBenchmarkSuite } from "../../src/admin/benchmark.js";

describe("benchmark suite configuration", () => {
  it("loads the expanded stable suite with required quality gates", async () => {
    const suite = await loadBenchmarkSuite(resolve(process.cwd(), "benchmarks/search-queries.json"));
    expect(suite.queries.length).toBeGreaterThanOrEqual(25);
    expect(suite.queries.some((entry) => entry.id === "stable-server-version" && entry.requiredTopK !== undefined)).toBe(true);
    expect(suite.queries.some((entry) => entry.relevant.some((relevance) => relevance.source === "minecraft_npm_stable"))).toBe(true);
  });

  it("loads a dedicated preview suite for beta/version/source coverage", async () => {
    const suite = await loadBenchmarkSuite(resolve(process.cwd(), "benchmarks/search-queries-preview.json"));
    expect(suite.queries.length).toBeGreaterThanOrEqual(10);
    expect(suite.queries.some((entry) => entry.id === "beta-server-version" && entry.requiredTopK !== undefined)).toBe(true);
    expect(suite.queries.some((entry) => entry.id === "beta-player-input-permissions")).toBe(true);
    expect(suite.queries.every((entry) => entry.includePreview === true)).toBe(true);
  });
});
