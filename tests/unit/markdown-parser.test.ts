import { describe, expect, it } from "vitest";
import { parseMarkdown } from "../../src/parsers/markdown.js";

describe("markdown parser", () => {
  it("parses front matter and heading-aware chunks", () => {
    const parsed = parseMarkdown(`---\ntitle: Test Document\ndescription: Useful docs\n---\n# Test Document\nIntro text.\n\n## Components\nUse minecraft:health here.`);
    expect(parsed.title).toBe("Test Document");
    expect(parsed.frontMatter.description).toBe("Useful docs");
    expect(parsed.chunks.some((chunk) => chunk.headingPath.includes("Components"))).toBe(true);
    expect(parsed.chunks.flatMap((chunk) => chunk.identifiers)).toContain("minecraft:health");
  });

  it("does not interpret headings inside fenced code as document headings", () => {
    const parsed = parseMarkdown("# Real\n```ts\n# not-a-heading\n```\nAfter");
    expect(parsed.chunks).toHaveLength(1);
    expect(parsed.chunks[0]?.content).toContain("# not-a-heading");
  });
});
