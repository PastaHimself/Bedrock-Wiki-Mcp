import { mkdtemp, mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../../src/db/connection.js";
import { updateConfiguredSourcesIndex } from "../../src/db/incremental-indexer.js";
import { rebuildConfiguredSourcesIndex } from "../../src/db/source-indexer.js";
import { exactIdentifierSearch } from "../../src/search/exact.js";

const temporaryDirectories: string[] = [];
const REPOSITORY = "https://github.com/example/stable-docs.git";

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "bedrock-mcp-incremental-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeRegistry(path: string): Promise<void> {
  await writeFile(path, JSON.stringify({
    sources: [{
      id: "stable_docs",
      name: "Stable docs",
      type: "git",
      tier: 1,
      repository: REPOSITORY,
      branch: "main",
      channel: "stable",
      include: ["creator/ScriptAPI/**"],
    }],
  }));
}

async function makeCheckout(root: string, revision: string): Promise<string> {
  const checkout = join(root, "stable_docs");
  const path = join(checkout, "creator", "ScriptAPI", "minecraft", "server", "System.md");
  await mkdir(join(checkout, ".git", "refs", "heads"), { recursive: true });
  await mkdir(join(checkout, "creator", "ScriptAPI", "minecraft", "server"), { recursive: true });
  await writeFile(join(checkout, ".git", "HEAD"), "ref: refs/heads/main\n");
  await writeFile(join(checkout, ".git", "refs", "heads", "main"), `${revision}\n`);
  await writeFile(join(checkout, ".git", "config"), `[remote \"origin\"]\n\turl = ${REPOSITORY}\n`);
  await writeFile(path, "# System Class\n## Methods\n### **runInterval**\n`runInterval(callback: () => void): number;`\nVersion one.");
  return path;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("incremental configured source indexing", () => {
  it("skips unchanged revisions and replaces only changed source content", async () => {
    const root = await temporaryDirectory();
    const dataDir = join(root, "data");
    const checkoutRoot = join(root, "checkouts");
    const configPath = join(root, "sources.json");
    await mkdir(checkoutRoot, { recursive: true });
    await writeRegistry(configPath);
    const documentPath = await makeCheckout(checkoutRoot, "1111111111111111111111111111111111111111");

    const initial = await rebuildConfiguredSourcesIndex({ dataDir, checkoutRoot, configPath });
    const unchanged = await updateConfiguredSourcesIndex({ dataDir, checkoutRoot, configPath });
    expect(unchanged.incremental).toBe(true);
    expect(unchanged.sourcesChanged).toBe(0);
    expect(unchanged.documentsModified).toBe(0);
    expect(unchanged.documentsUnchanged).toBe(1);

    await writeFile(join(checkoutRoot, "stable_docs", ".git", "refs", "heads", "main"), "2222222222222222222222222222222222222222\n");
    await writeFile(documentPath, "# System Class\n## Methods\n### **runInterval**\n`runInterval(callback: () => void, tickInterval?: number): number;`\nVersion two changed.");

    const changed = await updateConfiguredSourcesIndex({ dataDir, checkoutRoot, configPath });
    expect(changed.sourcesChanged).toBe(1);
    expect(changed.documentsModified).toBe(1);
    expect(changed.documentsDeleted).toBe(0);
    expect(changed.chunksChanged).toBeGreaterThan(0);

    const database = openDatabase(initial.targetPath, { mode: "readonly" });
    try {
      const hits = exactIdentifierSearch(database, "System.runInterval");
      expect(hits).toHaveLength(1);
      expect(hits[0]?.content).toContain("tickInterval");
    } finally {
      database.close();
    }
  });

  it("removes documents deleted in a newer source revision", async () => {
    const root = await temporaryDirectory();
    const dataDir = join(root, "data");
    const checkoutRoot = join(root, "checkouts");
    const configPath = join(root, "sources.json");
    await mkdir(checkoutRoot, { recursive: true });
    await writeRegistry(configPath);
    const documentPath = await makeCheckout(checkoutRoot, "1111111111111111111111111111111111111111");
    await rebuildConfiguredSourcesIndex({ dataDir, checkoutRoot, configPath });

    await writeFile(join(checkoutRoot, "stable_docs", ".git", "refs", "heads", "main"), "3333333333333333333333333333333333333333\n");
    await unlink(documentPath);
    const replacement = join(checkoutRoot, "stable_docs", "creator", "ScriptAPI", "minecraft", "server", "World.md");
    await writeFile(replacement, "# World Class\n## Methods\n### **getDimension**\n`getDimension(id: string): Dimension;`");

    const result = await updateConfiguredSourcesIndex({ dataDir, checkoutRoot, configPath });
    expect(result.documentsDeleted).toBe(1);
    expect(result.documentsAdded).toBe(1);

    const database = openDatabase(result.targetPath, { mode: "readonly" });
    try {
      expect(exactIdentifierSearch(database, "System.runInterval")).toHaveLength(0);
      expect(exactIdentifierSearch(database, "World.getDimension")).toHaveLength(1);
    } finally {
      database.close();
    }
  });
});
