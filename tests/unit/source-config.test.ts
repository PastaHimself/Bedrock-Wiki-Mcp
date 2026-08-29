import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isSafeSparsePath } from "../../src/sources/config.js";

interface SourceDefinition {
  id: string;
  tier: number;
  channel: string;
  repository: string;
  branch: string;
  defaultEnabled?: boolean;
  sparsePaths?: string[];
  include?: string[];
}

function loadSources(): SourceDefinition[] {
  const path = resolve(process.cwd(), "config/sources.json");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { sources: SourceDefinition[] };
  return parsed.sources;
}

describe("source configuration", () => {
  it("uses unique source IDs", () => {
    const sources = loadSources();
    expect(new Set(sources.map((source) => source.id)).size).toBe(sources.length);
  });

  it("keeps Creator documentation at trust tier 1", () => {
    const source = loadSources().find((candidate) => candidate.id === "ms_creator_docs");
    expect(source?.tier).toBe(1);
    expect(source?.repository).toBe("https://github.com/MicrosoftDocs/minecraft-creator.git");
  });

  it("does not enable preview samples by default", () => {
    const preview = loadSources().find((candidate) => candidate.id === "bedrock_samples_preview");
    expect(preview?.channel).toBe("preview");
    expect(preview?.defaultEnabled).toBe(false);
  });

  it("includes the additional stable Mojang and community references", () => {
    const sources = loadSources();
    const byId = new Map(sources.map((source) => [source.id, source]));
    expect(byId.get("minecraft_scripting_libraries")?.repository).toBe("https://github.com/Mojang/minecraft-scripting-libraries.git");
    expect(byId.get("minecraft_debugger")?.repository).toBe("https://github.com/Mojang/minecraft-debugger.git");
    expect(byId.get("minecraft_creator_tools")?.repository).toBe("https://github.com/Mojang/minecraft-creator-tools.git");

    const wiki = byId.get("bedrock_oss_wiki");
    expect(wiki?.repository).toBe("https://github.com/Bedrock-OSS/bedrock-wiki.git");
    expect(wiki?.branch).toBe("wiki");
    expect(wiki?.tier).toBe(3);
    expect(wiki?.sparsePaths).toEqual(["docs"]);

    const examples = byId.get("bedrock_oss_examples");
    expect(examples?.repository).toBe("https://github.com/Bedrock-OSS/bedrock-examples.git");
    expect(examples?.tier).toBe(3);
    expect(examples?.channel).toBe("stable");
    expect(examples?.sparsePaths).toEqual(["resources"]);
    expect(examples?.include).toContain("resources/**/*.json");
  });

  it("includes the expanded GitHub knowledge sources with safe scopes", () => {
    const expected = [
      ["bridge_core_docs", "https://github.com/bridge-core/docs.git", "main", "stable", ["docs"]],
      ["bridge_core_editor_packages", "https://github.com/bridge-core/editor-packages.git", "main", "stable", ["packages"]],
      ["blockception_language_server", "https://github.com/Blockception/minecraft-bedrock-language-server.git", "main", "stable", ["documentation", "ide", "packages", "tools"]],
      ["blockception_json_schemas", "https://github.com/Blockception/Minecraft-bedrock-json-schemas.git", "main", "stable", ["behavior", "docs", "general", "language", "resource", "skinpacks", "source", "worldgen"]],
      ["jayly_scriptapi", "https://github.com/JaylyDev/ScriptAPI.git", "stable", "stable", ["packages", "scripts", "tools"]],
      ["blockbench", "https://github.com/JannisX11/blockbench.git", "master", "stable", ["content", "js", "types"]],
      ["jannis_bedrock_schemas", "https://github.com/JannisX11/bedrock-json-schemas.git", "master", "unknown", undefined],
      ["nusiq_mcblend", "https://github.com/Nusiq/mcblend.git", "master", "stable", ["docs"]],
      ["bedrock_core_server", "https://github.com/bedrock-core/server.git", "main", "stable", ["packages", "types"]],
      ["minecraft_addon_toolchain", "https://github.com/minecraft-addon-tools/minecraft-addon-toolchain.git", "master", "unknown", ["packages"]],
    ] as const;

    const byId = new Map(loadSources().map((source) => [source.id, source]));
    for (const [id, repository, branch, channel, sparsePaths] of expected) {
      const source = byId.get(id);
      expect(source, id).toBeDefined();
      expect(source?.repository, id).toBe(repository);
      expect(source?.branch, id).toBe(branch);
      expect(source?.channel, id).toBe(channel);
      expect(source?.tier, id).toBe(3);
      expect(source?.defaultEnabled ?? true, id).toBe(true);
      if (sparsePaths) expect(source?.sparsePaths, id).toEqual(sparsePaths);
    }
  });

  it("keeps beta schemas, protocol data, scripting samples, GameTests, and Editor material preview-only", () => {
    const previewIds = [
      "bedrock_schemas_preview",
      "bedrock_protocol_docs_preview",
      "minecraft_scripting_samples_preview",
      "minecraft_gametests_preview",
      "minecraft_editor_preview",
      "minecraft_editor_extension_samples_preview",
      "minecraft_editor_extension_starter_preview",
    ];
    const byId = new Map(loadSources().map((source) => [source.id, source]));
    for (const id of previewIds) {
      expect(byId.get(id)?.channel, id).toBe("preview");
      expect(byId.get(id)?.defaultEnabled, id).toBe(false);
    }
  });

  it("accepts only safe repository-relative sparse checkout directories", () => {
    expect(isSafeSparsePath("docs")).toBe(true);
    expect(isSafeSparsePath("app/jsnode")).toBe(true);
    expect(isSafeSparsePath("../docs")).toBe(false);
    expect(isSafeSparsePath("/docs")).toBe(false);
    expect(isSafeSparsePath("-docs")).toBe(false);
    expect(isSafeSparsePath("docs/**")).toBe(false);
  });
});
