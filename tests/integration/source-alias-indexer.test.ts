import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../../src/db/connection.js";
import { rebuildConfiguredSourcesIndex } from "../../src/db/source-indexer.js";
import { exactIdentifierSearch } from "../../src/search/exact.js";

const temporaryDirectories: string[] = [];
const REVISION = "3333333333333333333333333333333333333333";
const REPOSITORY = "https://github.com/example/creator-docs.git";

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "bedrock-mcp-alias-index-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeCheckout(root: string): Promise<void> {
  const checkout = join(root, "creator_docs");
  const apiRoot = join(checkout, "creator", "ScriptAPI", "minecraft", "server");
  await mkdir(join(checkout, ".git", "refs", "heads"), { recursive: true });
  await mkdir(apiRoot, { recursive: true });
  await writeFile(join(checkout, ".git", "HEAD"), "ref: refs/heads/main\n");
  await writeFile(join(checkout, ".git", "refs", "heads", "main"), `${REVISION}\n`);
  await writeFile(join(checkout, ".git", "config"), `[remote \"origin\"]\n\turl = ${REPOSITORY}\n`);
  await writeFile(
    join(apiRoot, "World.md"),
    "# World Class\n## Properties\n### **afterEvents**\n`read-only afterEvents: WorldAfterEvents;`\nType: [*WorldAfterEvents*](WorldAfterEvents.md)",
  );
  await writeFile(
    join(apiRoot, "WorldAfterEvents.md"),
    "# WorldAfterEvents Class\n## Properties\n### **playerSpawn**\n`read-only playerSpawn: PlayerSpawnAfterEventSignal;`\nType: [*PlayerSpawnAfterEventSignal*](PlayerSpawnAfterEventSignal.md)",
  );
  await writeFile(
    join(apiRoot, "PlayerSpawnAfterEventSignal.md"),
    "# PlayerSpawnAfterEventSignal Class\n## Methods\n### **subscribe**\n`subscribe(callback: (arg: PlayerSpawnAfterEvent) => void): (arg: PlayerSpawnAfterEvent) => void;`",
  );
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("official source alias indexing", () => {
  it("materializes derived Script API chains before atomically publishing the index", async () => {
    const root = await temporaryDirectory();
    const dataDir = join(root, "data");
    const checkoutRoot = join(root, "checkouts");
    const configPath = join(root, "sources.json");
    await mkdir(checkoutRoot, { recursive: true });
    await writeCheckout(checkoutRoot);
    await writeFile(configPath, JSON.stringify({
      sources: [{
        id: "creator_docs",
        name: "Creator docs",
        type: "git",
        tier: 1,
        repository: REPOSITORY,
        branch: "main",
        channel: "stable",
        include: ["creator/ScriptAPI/**"],
      }],
    }));

    const result = await rebuildConfiguredSourcesIndex({ dataDir, checkoutRoot, configPath });
    expect(result.validation.ok).toBe(true);
    expect(result.aliasesDerived).toBeGreaterThanOrEqual(2);

    const database = openDatabase(result.targetPath, { mode: "readonly" });
    try {
      const event = exactIdentifierSearch(database, "world.afterEvents.playerSpawn");
      expect(event[0]?.identifier).toBe("WorldAfterEvents.playerSpawn");
      expect(event[0]?.isPrimary).toBe(true);

      const subscribe = exactIdentifierSearch(database, "world.afterEvents.playerSpawn.subscribe");
      expect(subscribe[0]?.identifier).toBe("PlayerSpawnAfterEventSignal.subscribe");
      expect(subscribe[0]?.isPrimary).toBe(true);
    } finally {
      database.close();
    }
  });
});
