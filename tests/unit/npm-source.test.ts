import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadNpmSourceRegistry,
  manifestTrackVersionFromNpmVersion,
  minecraftVersionFromNpmVersion,
  openNpmSnapshot,
  selectNpmSources,
  syncNpmSources,
  walkNpmSnapshotDocuments,
} from "../../src/sources/npm.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "bedrock-mcp-npm-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("npm Script API source", () => {
  it("extracts product builds and manifest track versions without conflating them", () => {
    expect(minecraftVersionFromNpmVersion("2.11.0-beta.1.26.50-preview.27")).toBe("1.26.50-preview.27");
    expect(manifestTrackVersionFromNpmVersion("2.11.0-beta.1.26.50-preview.27")).toBe("2.11.0-beta");
    expect(manifestTrackVersionFromNpmVersion("2.9.0")).toBe("2.9.0");
    expect(minecraftVersionFromNpmVersion("2.9.0")).toBeUndefined();
  });

  it("selects preview metadata only when explicitly enabled", async () => {
    const root = await temporaryDirectory();
    const configPath = join(root, "npm-sources.json");
    await writeFile(configPath, JSON.stringify({
      sources: [
        {
          id: "stable",
          name: "Stable",
          tier: 1,
          channel: "stable",
          defaultEnabled: true,
          packages: [{ name: "@minecraft/server", tags: ["latest"] }],
        },
        {
          id: "preview",
          name: "Preview",
          tier: 1,
          channel: "preview",
          defaultEnabled: false,
          packages: [{ name: "@minecraft/server", tags: ["beta"] }],
        },
      ],
    }));
    const registry = await loadNpmSourceRegistry(configPath);
    expect(selectNpmSources(registry.sources, false).map((source) => source.id)).toEqual(["stable"]);
    expect(selectNpmSources(registry.sources, true).map((source) => source.id)).toEqual(["stable", "preview"]);
  });

  it("creates bounded indexable snapshots with exact package provenance", async () => {
    const root = await temporaryDirectory();
    const configPath = join(root, "npm-sources.json");
    await writeFile(configPath, JSON.stringify({
      sources: [{
        id: "minecraft_npm_stable",
        name: "Official npm stable",
        tier: 1,
        channel: "stable",
        defaultEnabled: true,
        packages: [{ name: "@minecraft/server", tags: ["latest"] }],
      }],
    }));

    const registryBody = JSON.stringify({
      name: "@minecraft/server",
      description: "Bedrock Script API",
      "dist-tags": { latest: "2.9.0", beta: "2.11.0-beta.1.26.50-preview.27" },
      versions: {
        "2.9.0": { version: "2.9.0", peerDependencies: { "@minecraft/common": "^1.3.0" } },
        "2.8.0": { version: "2.8.0" },
        "2.11.0-beta.1.26.50-preview.27": { version: "2.11.0-beta.1.26.50-preview.27" },
      },
      time: {
        "2.8.0": "2026-07-01T00:00:00.000Z",
        "2.9.0": "2026-08-01T00:00:00.000Z",
        "2.11.0-beta.1.26.50-preview.27": "2026-08-27T00:00:00.000Z",
      },
    });
    const fetchImpl = async (input: string | URL | globalThis.Request): Promise<Response> => {
      expect(String(input)).toContain("registry.npmjs.org");
      return new Response(registryBody, {
        status: 200,
        headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(registryBody)) },
      });
    };

    const first = await syncNpmSources({ dataDir: root, configPath, fetchImpl });
    expect(first).toHaveLength(1);
    expect(first[0]?.status).toBe("created");
    expect(first[0]?.tags).toBe(1);

    const registry = await loadNpmSourceRegistry(configPath);
    const snapshot = await openNpmSnapshot(root, registry.sources[0]!);
    expect(snapshot.source.sourceType).toBe("npm");
    expect(snapshot.manifest.tags[0]).toMatchObject({
      packageName: "@minecraft/server",
      tag: "latest",
      version: "2.9.0",
      apiVersion: "2.9.0",
    });

    const markdown = await readFile(join(snapshot.directory, "metadata/ScriptAPI/minecraft/server/latest.md"), "utf8");
    expect(markdown).toContain("Exact npm package/type-definition version: `2.9.0`");
    expect(markdown).toContain('"module_name": "@minecraft/server"');
    expect(markdown).toContain('"version": "2.9.0"');

    const documents = [];
    for await (const document of walkNpmSnapshotDocuments(snapshot)) documents.push(document);
    expect(documents).toHaveLength(1);
    expect(documents[0]?.metadata.apiPackage).toBe("@minecraft/server");
    expect(documents[0]?.metadata.apiVersion).toBe("2.9.0");
    expect(documents[0]?.metadata.channel).toBe("stable");
    expect(documents[0]?.metadata.source.sourceType).toBe("npm");

    const unchanged = await syncNpmSources({ dataDir: root, configPath, fetchImpl });
    expect(unchanged[0]?.status).toBe("unchanged");
    expect(unchanged[0]?.revision).toBe(first[0]?.revision);
  });

  it("rejects non-Minecraft packages at configuration load", async () => {
    const root = await temporaryDirectory();
    const configPath = join(root, "npm-sources.json");
    await writeFile(configPath, JSON.stringify({
      sources: [{
        id: "unsafe",
        name: "Unsafe",
        tier: 1,
        channel: "stable",
        packages: [{ name: "left-pad", tags: ["latest"] }],
      }],
    }));
    await expect(loadNpmSourceRegistry(configPath)).rejects.toThrow();
  });
});
