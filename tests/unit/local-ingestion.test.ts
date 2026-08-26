import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ingestLocalDirectory } from "../../src/ingestion/local.js";
import type { SourceDescriptor } from "../../src/models/source.js";

const roots: string[] = [];
const source: SourceDescriptor = {
  id: "local",
  name: "Local knowledge",
  tier: 3,
  channel: "stable",
  revision: "local-test",
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("local directory ingestion", () => {
  it("recursively ingests supported text files in deterministic path order", async () => {
    const root = await mkdtemp(join(tmpdir(), "bedrock-mcp-"));
    roots.push(root);
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "z.md"), "# Zed\nUse minecraft:health.", "utf8");
    await writeFile(join(root, "nested", "a.json"), JSON.stringify({ "minecraft:entity": { description: { identifier: "example:test" } } }), "utf8");
    await writeFile(join(root, "image.png"), "not really an image", "utf8");

    const documents = await ingestLocalDirectory(root, source);
    expect(documents.map((document) => document.metadata.path)).toEqual(["nested/a.json", "z.md"]);
    expect(documents[1]?.metadata.contentHash).toMatch(/^sha256:/);
    expect(documents[1]?.metadata.revision).toBe("local-test");
  });

  it("skips files above the configured size cap", async () => {
    const root = await mkdtemp(join(tmpdir(), "bedrock-mcp-"));
    roots.push(root);
    await writeFile(join(root, "large.md"), "# Large\n" + "x".repeat(100), "utf8");
    expect(await ingestLocalDirectory(root, source, { maxFileBytes: 20 })).toEqual([]);
  });

  it("rejects invalid file-size limits", async () => {
    const root = await mkdtemp(join(tmpdir(), "bedrock-mcp-"));
    roots.push(root);
    await expect(ingestLocalDirectory(root, source, { maxFileBytes: 0 })).rejects.toThrow("maxFileBytes");
  });
});
