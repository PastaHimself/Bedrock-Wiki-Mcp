import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../../src/db/connection.js";
import { updateConfiguredSourcesIndex } from "../../src/db/incremental-indexer.js";
import { rebuildConfiguredSourcesIndex } from "../../src/db/source-indexer.js";
import { exactIdentifierSearch } from "../../src/search/exact.js";

const temporaryDirectories: string[] = [];
const REVISION = "1111111111111111111111111111111111111111";
const REPOSITORY = "https://github.com/example/stable-docs.git";

async function writeRegistry(path: string, include: string): Promise<void> {
  await writeFile(path, JSON.stringify({
    sources: [{
      id: "stable_docs",
      name: "Stable docs",
      type: "git",
      tier: 1,
      repository: REPOSITORY,
      branch: "main",
      channel: "stable",
      include: [include],
    }],
  }));
}

async function setupCheckout(root: string): Promise<void> {
  const checkout = join(root, "stable_docs");
  const docs = join(checkout, "creator", "ScriptAPI", "minecraft", "server");
  await mkdir(join(checkout, ".git", "refs", "heads"), { recursive: true });
  await mkdir(docs, { recursive: true });
  await writeFile(join(checkout, ".git", "HEAD"), "ref: refs/heads/main\n");
  await writeFile(join(checkout, ".git", "refs", "heads", "main"), `${REVISION}\n`);
  await writeFile(join(checkout, ".git", "config"), `[remote \"origin\"]\n\turl = ${REPOSITORY}\n`);
  await writeFile(join(docs, "System.md"), "# System Class\n## Methods\n### **runInterval**\n`runInterval(callback: () => void): number;`");
  await writeFile(join(docs, "World.md"), "# World Class\n## Methods\n### **getDimension**\n`getDimension(id: string): Dimension;`");
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("incremental source configuration identity", () => {
  it("re-evaluates include rules even when the upstream revision is unchanged", async () => {
    const root = await mkdtemp(join(tmpdir(), "bedrock-mcp-input-identity-"));
    temporaryDirectories.push(root);
    const dataDir = join(root, "data");
    const checkoutRoot = join(root, "checkouts");
    const configPath = join(root, "sources.json");
    await mkdir(checkoutRoot, { recursive: true });
    await setupCheckout(checkoutRoot);

    await writeRegistry(configPath, "creator/ScriptAPI/**/System.md");
    await rebuildConfiguredSourcesIndex({ dataDir, checkoutRoot, configPath });

    await writeRegistry(configPath, "creator/ScriptAPI/**/World.md");
    const result = await updateConfiguredSourcesIndex({ dataDir, checkoutRoot, configPath });
    expect(result.sourcesChanged).toBe(1);
    expect(result.documentsAdded).toBe(1);
    expect(result.documentsDeleted).toBe(1);

    const database = openDatabase(result.targetPath, { mode: "readonly" });
    try {
      expect(exactIdentifierSearch(database, "System.runInterval")).toHaveLength(0);
      expect(exactIdentifierSearch(database, "World.getDimension")).toHaveLength(1);
    } finally {
      database.close();
    }
  });
});
