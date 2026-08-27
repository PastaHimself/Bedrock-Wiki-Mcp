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
