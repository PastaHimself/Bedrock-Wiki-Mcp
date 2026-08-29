import { describe, expect, it } from "vitest";
import type { KnowledgeSearchResult } from "../../src/search/engine.js";
import { answerBedrock } from "../../src/ai/answer.js";
import {
  buildGroundedMessages,
  cleanGeneratedAnswer,
  formatGroundedEvidence,
} from "../../src/ai/grounded-answer.js";

function result(overrides: Partial<KnowledgeSearchResult> = {}): KnowledgeSearchResult {
  return {
    chunkId: "chk_input",
    documentId: "doc_input",
    title: "Player input",
    excerpt: "Use world.afterEvents to subscribe to input events.",
    path: "creator/ScriptAPI/player-input.md",
    kind: "api",
    category: "script-api",
    stability: "stable",
    lifecycle: "active",
    channel: "stable",
    sourceId: "minecraft_creator_docs",
    sourceName: "Minecraft Creator Docs",
    sourceType: "git",
    sourceTier: 1,
    score: 100,
    exactMatch: false,
    ...overrides,
  };
}

describe("grounded Bedrock answers", () => {
  it("labels bounded evidence and instructs Qwen to cite only indexed resources", () => {
    const evidence = formatGroundedEvidence([result()]);
    expect(evidence.text).toContain("[R1]");
    expect(evidence.text).toContain("UNTRUSTED INDEXED EVIDENCE");
    expect(evidence.citations).toEqual([expect.objectContaining({
      id: "R1",
      chunkId: "chk_input",
      sourceId: "minecraft_creator_docs",
    })]);

    const messages = buildGroundedMessages("How do I listen for input?", evidence);
    expect(messages[0]?.content).toContain("Use ONLY the evidence");
    expect(messages[1]?.content).toContain("/no_think");
    expect(messages[1]?.content).toContain("[R1]");
  });

  it("keeps the evidence payload within the small-model context budget", () => {
    const evidence = formatGroundedEvidence([result({ excerpt: "x".repeat(9_000) })], 8_000);
    expect(evidence.text.length).toBeLessThanOrEqual(8_000);
  });

  it("removes Qwen thinking markers from the user-facing answer", () => {
    expect(cleanGeneratedAnswer("<think>private reasoning</think>Use [R1]."))
      .toBe("Use [R1].");
  });

  it("retrieves evidence, calls the local model, and returns citation mappings", async () => {
    const resource = result();
    const output = await answerBedrock({
      retrievalLimit: 2,
      search: async (options) => {
        expect(options.query).toBe("How do I listen for input?");
        expect(options.limit).toBe(2);
        return { query: options.query, results: [resource], truncated: false, totalChars: resource.excerpt.length };
      },
      llm: {
        model: "Qwen/Qwen3-1.7B-GGUF:Q8_0",
        chat: async (request) => {
          expect(request.messages[1]?.content).toContain("How do I listen for input?");
          return "Subscribe to the event [R1].";
        },
      },
    }, { query: "How do I listen for input?" });

    expect(output).toMatchObject({
      query: "How do I listen for input?",
      answer: "Subscribe to the event [R1].",
      model: "Qwen/Qwen3-1.7B-GGUF:Q8_0",
      candidateCount: 1,
      grounded: true,
    });
    expect(output.citations).toEqual([expect.objectContaining({ id: "R1", chunkId: "chk_input" })]);
  });

  it("flags answers with unavailable or missing citations instead of presenting them as grounded", async () => {
    const resource = result();
    const unknownCitation = await answerBedrock({
      retrievalLimit: 2,
      search: async () => ({ query: "question", results: [resource], truncated: false, totalChars: resource.excerpt.length }),
      llm: {
        model: "qwen",
        chat: async () => "Use [R99].",
      },
    }, { query: "question" });
    expect(unknownCitation.grounded).toBe(false);
    expect(unknownCitation.citations).toEqual([]);
    expect(unknownCitation.warning).toContain("R99");

    const missingCitation = await answerBedrock({
      retrievalLimit: 2,
      search: async () => ({ query: "question", results: [resource], truncated: false, totalChars: resource.excerpt.length }),
      llm: {
        model: "qwen",
        chat: async () => "I cannot determine that from the supplied material.",
      },
    }, { query: "question" });
    expect(missingCitation.grounded).toBe(false);
    expect(missingCitation.warning).toContain("no valid resource citations");
  });

  it("does not ask the model to answer when retrieval has no evidence", async () => {
    let modelCalled = false;
    const output = await answerBedrock({
      retrievalLimit: 2,
      search: async () => ({ query: "unknown", results: [], truncated: false, totalChars: 0 }),
      llm: {
        model: "Qwen/Qwen3-1.7B-GGUF:Q8_0",
        chat: async () => {
          modelCalled = true;
          return "hallucinated";
        },
      },
    }, { query: "unknown" });

    expect(modelCalled).toBe(false);
    expect(output.answer).toContain("could not find supporting");
    expect(output.candidateCount).toBe(0);
    expect(output.grounded).toBe(false);
    expect(output.warning).toContain("No indexed resources");
  });
});
