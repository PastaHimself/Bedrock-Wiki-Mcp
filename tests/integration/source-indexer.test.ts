import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../../src/db/connection.js";
import { migrateDatabase } from "../../src/db/migrate.js";
import { rebuildConfiguredSourcesIndex } from "../../src/db/source-indexer.js";
import { exactIdentifierSearch } from "../../src/search/exact.js";
import { listKnowledgeSources } from "../../src/search/discovery.js";

const temporaryDirectories: string[] = [];
const STABLE_REVISION = "1111111111111111111111111111111111111111";
const PREVIEW_REVISION = "2222222222222222222222222222222222222222";

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "bedrock-mcp-index-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function makeCheckout(
  root: string,
  id: string,
  revision: string,
  relativePath: string,
  content: string,
  repository: string,
  branch = "main",
): Promise<void> {
  const checkout = join(root, id);
  await mkdir(join(checkout, ".git", "refs", "heads"), { recursive: true });
  await mkdir(join(checkout, ...relativePath.split("/").slice(0, -1)), { recursive: true });
  await writeFile(join(checkout, ".git", "HEAD"), `ref: refs/heads/${branch}\n`);
  await writeFile(join(checkout, ".git", "refs", "heads", branch), `${revision}\n`);
  await writeFile(join(checkout, ".git", "config"), `[remote \"origin\"]\n\turl = ${repository}\n`);
  await writeFile(join(checkout, ...relativePath.split("/")), content);
}

async function writeRegistry(path: string, includeMissing = false): Promise<void> {
  const sources: unknown[] = [
    {
      id: "stable_docs",
      name: "Stable docs",
      type: "git",
      tier: 1,
      repository: "https://github.com/example/stable-docs.git",
      branch: "main",
      channel: "stable",
      include: ["creator/ScriptAPI/**"],
    },
    {
      id: "preview_docs",
      name: "Preview docs",
      type: "git",
      tier: 1,
      repository: "https://github.com/example/preview-docs.git",
      branch: "preview",
      channel: "preview",
      include: ["creator/ScriptAPI/**"],
    },
  ];
  if (includeMissing) {
    sources.push({
      id: "missing_docs",
      name: "Missing docs",
      type: "git",
      tier: 2,
      repository: "https://github.com/example/missing.git",
      branch: "main",
      channel: "stable",
    });
  }
  await writeFile(path, JSON.stringify({ sources }));
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("configured source indexing", () => {
  it("indexes stable sources by default and preview sources only on opt-in", async () => {
    const root = await temporaryDirectory();
    const dataDir = join(root, "data");
    const checkoutRoot = join(root, "checkouts");
    const configPath = join(root, "sources.json");
    await mkdir(checkoutRoot, { recursive: true });
    await writeRegistry(configPath);
    await makeCheckout(
      checkoutRoot,
      "stable_docs",
      STABLE_REVISION,
      "creator/ScriptAPI/minecraft/server/System.md",
      "# System Class\n## Methods\n### **runInterval**\n`runInterval(callback: () => void): number;`\nSchedules work.",
      "https://github.com/example/stable-docs.git",
    );
    await makeCheckout(
      checkoutRoot,
      "preview_docs",
      PREVIEW_REVISION,
      "creator/ScriptAPI/minecraft/server/SystemPreview.md",
      "# System Class\n## Methods\n::: moniker range=\"=minecraft-bedrock-experimental\"\n### **runInterval**\n`runInterval(callback: () => void): number;`\nPreview behavior.\n::: moniker-end",
      "https://github.com/example/preview-docs.git",
      "preview",
    );

    const stableResult = await rebuildConfiguredSourcesIndex({ dataDir, checkoutRoot, configPath });
    expect(stableResult.sources.map((source) => source.sourceId)).toEqual(["stable_docs"]);
    expect(stableResult.validation.ok).toBe(true);
    expect(await readdir(join(dataDir, "index"))).toEqual(["bedrock.db"]);

    let database = openDatabase(stableResult.targetPath, { mode: "readonly" });
    const journal = database.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(journal.journal_mode.toLowerCase()).toBe("delete");
    expect(listKnowledgeSources(database).map((source) => source.id)).toEqual(["stable_docs"]);
    expect(listKnowledgeSources(database)[0]?.revision).toBe(STABLE_REVISION);
    expect(exactIdentifierSearch(database, "System.runInterval")).toHaveLength(1);
    database.close();

    const previewResult = await rebuildConfiguredSourcesIndex({
      dataDir,
      checkoutRoot,
      configPath,
      includePreview: true,
    });
    expect(previewResult.sources.map((source) => source.sourceId)).toEqual(["stable_docs", "preview_docs"]);
    expect(await readdir(join(dataDir, "index"))).toEqual(["bedrock.db"]);

    database = openDatabase(previewResult.targetPath, { mode: "readonly" });
    const hits = exactIdentifierSearch(database, "System.runInterval");
    expect(hits).toHaveLength(2);
    expect(hits[0]?.channel).toBe("stable");
    expect(hits[1]?.channel).toBe("preview");
    database.close();
  });

  it("leaves an existing valid index untouched when a configured checkout is missing", async () => {
    const root = await temporaryDirectory();
    const dataDir = join(root, "data");
    const checkoutRoot = join(root, "checkouts");
    const configPath = join(root, "sources.json");
    const targetPath = join(dataDir, "index", "bedrock.db");
    await mkdir(join(dataDir, "index"), { recursive: true });
    await mkdir(checkoutRoot, { recursive: true });
    await writeRegistry(configPath, true);
    await makeCheckout(
      checkoutRoot,
      "stable_docs",
      STABLE_REVISION,
      "creator/ScriptAPI/minecraft/server/System.md",
      "# System Class\n## Methods\n### **runInterval**\n`runInterval(callback: () => void): number;`",
      "https://github.com/example/stable-docs.git",
    );

    const existing = openDatabase(targetPath);
    migrateDatabase(existing);
    existing.prepare("INSERT INTO index_meta(key, value) VALUES ('sentinel', 'keep-me')").run();
    existing.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    existing.close();

    await expect(rebuildConfiguredSourcesIndex({ dataDir, checkoutRoot, configPath })).rejects.toThrow("SOURCE_CHECKOUT_MISSING");

    const preserved = openDatabase(targetPath, { mode: "readonly" });
    const sentinel = preserved.prepare("SELECT value FROM index_meta WHERE key = 'sentinel'").get() as { value: string } | undefined;
    expect(sentinel?.value).toBe("keep-me");
    preserved.close();

    const files = await readdir(join(dataDir, "index"));
    expect(files.filter((name) => name.includes(".building.db"))).toEqual([]);
  });

  it("fails instead of silently accepting an enabled source with no matching documents", async () => {
    const root = await temporaryDirectory();
    const dataDir = join(root, "data");
    const checkoutRoot = join(root, "checkouts");
    const configPath = join(root, "sources.json");
    await mkdir(checkoutRoot, { recursive: true });
    await writeRegistry(configPath);
    await makeCheckout(
      checkoutRoot,
      "stable_docs",
      STABLE_REVISION,
      "creator/Documents/health.md",
      "# Health\nThis file intentionally does not match the configured ScriptAPI include glob.",
      "https://github.com/example/stable-docs.git",
    );

    await expect(rebuildConfiguredSourcesIndex({ dataDir, checkoutRoot, configPath })).rejects.toThrow("SOURCE_EMPTY");
    const files = await readdir(join(dataDir, "index"));
    expect(files.filter((name) => name.includes(".building.db"))).toEqual([]);
  });
});
