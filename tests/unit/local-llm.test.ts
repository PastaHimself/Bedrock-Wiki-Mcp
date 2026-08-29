import { describe, expect, it } from "vitest";
import { LocalLlmClient } from "../../src/ai/local-llm.js";

function fakeResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("LocalLlmClient", () => {
  it("serializes a bounded OpenAI-compatible chat request and returns the answer", async () => {
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    const client = new LocalLlmClient({
      baseUrl: "http://127.0.0.1:8081/v1/",
      model: "Qwen/Qwen3-1.7B-GGUF:Q8_0",
      timeoutMs: 1000,
      maxTokens: 256,
      fetchImpl: async (input, init) => {
        requestUrl = String(input);
        requestInit = init;
        return fakeResponse({ choices: [{ message: { content: "Use [R1]." } }] });
      },
    });

    await expect(client.chat({
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "question" },
      ],
      temperature: 0.1,
    })).resolves.toBe("Use [R1].");

    expect(requestUrl).toBe("http://127.0.0.1:8081/v1/chat/completions");
    expect(requestInit?.method).toBe("POST");
    expect(requestInit?.headers).toMatchObject({ "content-type": "application/json" });
    expect(JSON.parse(String(requestInit?.body))).toEqual({
      model: "Qwen/Qwen3-1.7B-GGUF:Q8_0",
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "question" },
      ],
      temperature: 0.1,
      max_tokens: 256,
      stream: false,
    });
  });

  it("maps an aborted request to a timeout error", async () => {
    const client = new LocalLlmClient({
      baseUrl: "http://127.0.0.1:8081/v1",
      model: "qwen",
      timeoutMs: 1000,
      maxTokens: 64,
      fetchImpl: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    });

    await expect(client.chat({ messages: [{ role: "user", content: "question" }] }))
      .rejects.toMatchObject({ code: "LOCAL_LLM_TIMEOUT" });
  });

  it("rejects HTTP failures and malformed model responses with typed errors", async () => {
    const failed = new LocalLlmClient({
      baseUrl: "http://127.0.0.1:8081/v1",
      model: "qwen",
      timeoutMs: 1000,
      maxTokens: 64,
      fetchImpl: async () => fakeResponse({ error: "busy" }, 503),
    });
    await expect(failed.chat({ messages: [{ role: "user", content: "question" }] }))
      .rejects.toMatchObject({ code: "LOCAL_LLM_HTTP_ERROR" });

    const malformed = new LocalLlmClient({
      baseUrl: "http://127.0.0.1:8081/v1",
      model: "qwen",
      timeoutMs: 1000,
      maxTokens: 64,
      fetchImpl: async () => fakeResponse({ choices: [{ message: {} }] }),
    });
    await expect(malformed.chat({ messages: [{ role: "user", content: "question" }] }))
      .rejects.toMatchObject({ code: "LOCAL_LLM_INVALID_RESPONSE" });
  });
});
