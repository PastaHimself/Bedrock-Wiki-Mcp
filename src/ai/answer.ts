import type { LocalLlm } from "./local-llm.js";
import {
  buildGroundedMessages,
  citationsInAnswer,
  cleanGeneratedAnswer,
  formatGroundedEvidence,
  MAX_GROUNDED_EVIDENCE_CHARS,
  type GroundedCitation,
  unknownCitationIds,
} from "./grounded-answer.js";
import type {
  KnowledgeSearchOptions,
  KnowledgeSearchResponse,
  KnowledgeSearchResult,
} from "../search/engine.js";

export interface BedrockAnswerDependencies {
  readonly llm: LocalLlm;
  readonly retrievalLimit: number;
  readonly search: (options: KnowledgeSearchOptions) => KnowledgeSearchResponse | Promise<KnowledgeSearchResponse>;
}

export interface BedrockAnswerResponse {
  readonly query: string;
  readonly answer: string;
  readonly model: string;
  readonly resources: readonly KnowledgeSearchResult[];
  readonly citations: readonly GroundedCitation[];
  readonly candidateCount: number;
  readonly grounded: boolean;
  readonly warning?: string;
}

export async function answerBedrock(
  dependencies: BedrockAnswerDependencies,
  options: KnowledgeSearchOptions,
): Promise<BedrockAnswerResponse> {
  if (!Number.isSafeInteger(dependencies.retrievalLimit) || dependencies.retrievalLimit < 1 || dependencies.retrievalLimit > 8) {
    throw new RangeError("retrievalLimit must be an integer between 1 and 8");
  }

  const retrieval = await dependencies.search({
    ...options,
    limit: Math.min(options.limit ?? dependencies.retrievalLimit, dependencies.retrievalLimit),
    maxChars: MAX_GROUNDED_EVIDENCE_CHARS,
  });
  const resources = retrieval.results.slice(0, dependencies.retrievalLimit);
  if (resources.length === 0) {
    return {
      query: retrieval.query,
      answer: "I could not find supporting Bedrock resources in the local index.",
      model: dependencies.llm.model,
      resources,
      citations: [],
      candidateCount: 0,
      grounded: false,
      warning: "No indexed resources were found; no model-grounded answer was generated.",
    };
  }

  const evidence = formatGroundedEvidence(resources);
  const generated = cleanGeneratedAnswer(await dependencies.llm.chat({
    messages: buildGroundedMessages(retrieval.query, evidence),
    temperature: 0.1,
  }));
  if (!generated) throw new Error("LOCAL_LLM_INVALID_RESPONSE: local model returned an empty answer");

  const citations = citationsInAnswer(generated, evidence.citations);
  const unknownIds = unknownCitationIds(generated, evidence.citations);
  const warning = unknownIds.length > 0
    ? "The local model cited resource markers not supplied in the evidence: " + unknownIds.join(", ") + "."
    : citations.length === 0
      ? "The local model returned no valid resource citations."
      : undefined;

  return {
    query: retrieval.query,
    answer: generated,
    model: dependencies.llm.model,
    resources,
    citations,
    candidateCount: resources.length,
    grounded: citations.length > 0 && unknownIds.length === 0,
    ...(warning ? { warning } : {}),
  };
}
