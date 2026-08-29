import { access, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createBackup } from "../../src/admin/backup.js";
import { runBenchmark, type BenchmarkSuite } from "../../src/admin/benchmark.js";
import { readIndexStatus } from "../../src/admin/status.js";
import { openDatabase } from "../../src/db/connection.js";
import { migrateDatabase } from "../../src/db/migrate.js";
import { IndexRepository } from "../../src/db/repository.js";
import { validateIndex } from "../../src/db/validate.js";
import { ingestDocument } from "../../src/ingestion/pipeline.js";
import type { SourceDescriptor } from "../../src/models/source.js";

const temporaryDirectories: string[] = [];

const source: SourceDescriptor = {
  id: "official",
  name: "Official docs",
  tier: 1,
  channel: "stable",
  revision: "1234567890abcdef1234567890abcdef12345678",
  repository: "https://github.com/example/official",
  branch: "main",
};

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "bedrock-admin-quality-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function buildIndex(root: string): Promise<string> {
  const path = join(root, "data", "index", "bedrock.db");
  const database = openDatabase(path);
  try {
    migrateDatabase(database);
    const repository = new IndexRepository(database);
    repository.replaceDocument(ingestDocument({
      source,
      path: "behavior_pack/entities/health.json",
      content: JSON.stringify({
        "minecraft:entity": {
          description: { identifier: "example:tank" },
          components: { "minecraft:health": { value: 40, max: 40 } },
        },
      }),
    }));
    repository.replaceDocument(ingestDocument({
      source,
      path: "behavior_pack/entities/targeting.json",
      content: JSON.stringify({
        "minecraft:entity": {
          description: { identifier: "example:hunter" },
          components: { "minecraft:behavior.nearest_attackable_target": { priority: 1 } },
        },
      }),
    }));
  } finally {
    database.close();
  }
  return path;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("administrative quality operations", () => {
  it("reports source/index status from a read-only database", async () => {
    const root = await temporaryDirectory();
    const path = await buildIndex(root);
    const database = openDatabase(path, { mode: "readonly" });
    try {
      const status = await readIndexStatus(database, path);
      expect(status.validation.ok).toBe(true);
      expect(status.validation.documents).toBe(2);
      expect(status.validation.chunks).toBeGreaterThanOrEqual(2);
      expect(status.indexBytes).toBeGreaterThan(0);
      expect(status.sources).toHaveLength(1);
      expect(status.sources[0]?.id).toBe("official");
      expect(status.sources[0]?.documents).toBe(2);
      expect(status.sources[0]?.revision).toBe(source.revision);
    } finally {
      database.close();
    }
  });

  it("creates online-readable backups, skips symlinks, and prunes retention", async () => {
    const root = await temporaryDirectory();
    const path = await buildIndex(root);
    const projectRoot = join(root, "project");
    const dataDir = join(root, "data");
    await mkdir(join(projectRoot, "config"), { recursive: true });
    await mkdir(join(projectRoot, "knowledge", "local"), { recursive: true });
    await writeFile(join(projectRoot, "config", "sources.json"), "{\"sources\":[]}\n");
    await writeFile(join(projectRoot, "knowledge", "local", "notes.md"), "# Local note\n");
    const secret = join(root, "secret.txt");
    await writeFile(secret, "do not copy\n");
    await symlink(secret, join(projectRoot, "knowledge", "local", "secret-link"));

    const first = await createBackup({
      dataDir,
      projectRoot,
      retain: 2,
      now: new Date("2026-08-25T01:02:03Z"),
    });
    await createBackup({
      dataDir,
      projectRoot,
      retain: 2,
      now: new Date("2026-08-26T01:02:03Z"),
    });
    const third = await createBackup({
      dataDir,
      projectRoot,
      retain: 2,
      now: new Date("2026-08-27T01:02:03Z"),
    });

    expect(third.removedBackups).toContain("20260825T010203Z");
    await expect(access(first.directory)).rejects.toThrow();
    await expect(access(join(third.directory, "knowledge", "local", "secret-link"))).rejects.toThrow();
    expect(await readFile(join(third.directory, "knowledge", "local", "notes.md"), "utf8")).toContain("Local note");

    const backupDatabase = openDatabase(join(third.directory, "bedrock.db"), { mode: "readonly" });
    try {
      const report = validateIndex(backupDatabase);
      expect(report.ok).toBe(true);
      expect(report.documents).toBe(2);
    } finally {
      backupDatabase.close();
    }
    expect(path).toContain(join("data", "index", "bedrock.db"));
  });

  it("computes retrieval metrics and enforces provenance-aware required rank gates", async () => {
    const root = await temporaryDirectory();
    const path = await buildIndex(root);
    const database = openDatabase(path, { mode: "readonly" });
    const suite: BenchmarkSuite = {
      name: "test suite",
      targets: { exactTop1: 1, naturalTop3: 1, usefulTop5: 1 },
      queries: [
        {
          id: "health-exact",
          kind: "exact",
          query: "minecraft:health",
          requiredTopK: 1,
          relevant: [{ identifier: "minecraft:health", source: "official", category: "entities", grade: 3 }],
        },
        {
          id: "target-natural-metric",
          kind: "natural",
          query: "minecraft:behavior.nearest_attackable_target",
          relevant: [{ identifier: "minecraft:behavior.nearest_attackable_target", source: "official", grade: 3 }],
        },
      ],
    };
    try {
      const summary = runBenchmark(database, suite);
      expect(summary.passedTargets).toBe(true);
      expect(summary.requiredGatePassed).toBe(true);
      expect(summary.requiredCases).toBe(1);
      expect(summary.requiredCasesPassed).toBe(1);
      expect(summary.mrr).toBe(1);
      expect(summary.recallAt3).toBe(1);
      expect(summary.recallAt5).toBe(1);
      expect(summary.ndcgAt5).toBe(1);
      expect(summary.exactTop1).toBe(1);
      expect(summary.naturalTop3).toBe(1);
      expect(summary.usefulTop5).toBe(1);
      expect(summary.cases[0]?.topResults[0]).toContain("official/stable/entities");
    } finally {
      database.close();
    }
  });
});
