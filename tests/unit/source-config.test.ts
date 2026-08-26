import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

interface SourceDefinition {
  id: string;
  tier: number;
  channel: string;
  repository: string;
  defaultEnabled?: boolean;
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
});
