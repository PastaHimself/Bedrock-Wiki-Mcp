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

  it("includes the high-capacity creator corpus with bounded text/code scopes", () => {
    const expected = [
      ["jayly_scriptapi_docs", "https://github.com/JaylyDev/scriptapi-docs.git", 3, ["docs", "examples"]],
      ["bedrock_oss_regolith", "https://github.com/Bedrock-OSS/regolith.git", 3, ["docs", "templates"]],
      ["worldedit_be", "https://github.com/SIsilicon/WorldEdit-BE.git", 3, ["BP"]],
      ["jannis_snowstorm", "https://github.com/JannisX11/snowstorm.git", 3, undefined],
      ["bridge_core_legacy_editor", "https://github.com/bridge-core/bridge..git", 4, ["app"]],
      ["minecraft_scripting_types_historical", "https://github.com/minecraft-addon-tools/minecraft-scripting-types.git", 4, undefined],
      ["bedrock_studio_schemas_historical", "https://github.com/bedrock-studio/bedrock-json-schemas.git", 4, undefined],
      ["blockception_molang_historical", "https://github.com/Blockception/BC-Minecraft-Molang.git", 4, undefined],
      ["magic_method_docs", "https://github.com/notchyves/MagicMethodDocs.git", 4, undefined],
      ["render_method_docs", "https://github.com/notchyves/RenderMethodDocs.git", 4, undefined],
    ] as const;

    const byId = new Map(loadSources().map((source) => [source.id, source]));
    for (const [id, repository, tier, sparsePaths] of expected) {
      const source = byId.get(id);
      expect(source, id).toBeDefined();
      expect(source?.repository, id).toBe(repository);
      expect(source?.tier, id).toBe(tier);
      expect(source?.defaultEnabled ?? true, id).toBe(true);
      if (sparsePaths) expect(source?.sparsePaths, id).toEqual(sparsePaths);
      expect(source?.include?.length, id).toBeGreaterThan(0);
    }
  });

  it("indexes the full official preview schema text surface", () => {
    const source = loadSources().find((candidate) => candidate.id === "bedrock_schemas_preview");
    expect(source?.tier).toBe(1);
    expect(source?.channel).toBe("preview");
    expect(source?.defaultEnabled).toBe(false);
    expect(source?.sparsePaths).toEqual(["schemas", "types", "forms"]);
    expect(source?.include).toContain("catalog.json");
    expect(source?.include).toContain("types/**/*.d.ts");
    expect(source?.include).toContain("forms/**/*.json");
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
