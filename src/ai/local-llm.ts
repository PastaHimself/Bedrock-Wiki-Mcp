import { z } from "zod/v4";

const MAX_RESPONSE_CHARS = 2_000_000;

const chatResponseSchema = z.object({
  choices: z.array(z.object({
    message: z.object({
      content: z.string().min(1),
    }),
  })).min(1),
});

export type LocalLlmErrorCode =
  | "LOCAL_LLM_INVALID_REQUEST"
  | "LOCAL_LLM_TIMEOUT"
  | "LOCAL_LLM_UNAVAILABLE"
  | "LOCAL_LLM_HTTP_ERROR"
  | "LOCAL_LLM_INVALID_RESPONSE";

export class LocalLlmError extends Error {
  readonly code: LocalLlmErrorCode;

  constructor(code: LocalLlmErrorCode, message: string) {
    super(code + ": " + message);
    this.name = "LocalLlmError";
    this.code = code;
  }
}

export interface LocalLlmMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface LocalLlmChatRequest {
  readonly messages: readonly LocalLlmMessage[];
  readonly temperature?: number;
  readonly maxTokens?: number;
}

export interface LocalLlm {
  readonly model: string;
  chat(request: LocalLlmChatRequest): Promise<string>;
}

export interface LocalLlmClientOptions {
  readonly baseUrl: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly maxTokens: number;
  readonly fetchImpl?: typeof fetch;
}

export function isLoopbackLlmBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLocaleLowerCase("en-US");
    return url.protocol === "http:"
      && ["127.0.0.1", "localhost", "::1", "[::1]"].includes(hostname);
  } catch {
    return false;
  }
}

function responseDetail(body: string): string {
  return body.replace(/\s+/g, " ").trim().slice(0, 240);
}

export class LocalLlmClient implements LocalLlm {
  readonly model: string;

  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxTokens: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: LocalLlmClientOptions) {
    if (!isLoopbackLlmBaseUrl(options.baseUrl)) {
      throw new LocalLlmError(
        "LOCAL_LLM_INVALID_REQUEST",
        "the local model endpoint must use http://localhost, http://127.0.0.1, or http://[::1]",
      );
    }
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1_000 || options.timeoutMs > 120_000) {
      throw new LocalLlmError("LOCAL_LLM_INVALID_REQUEST", "timeoutMs must be between 1000 and 120000");
    }
    if (!Number.isSafeInteger(options.maxTokens) || options.maxTokens < 1 || options.maxTokens > 8_192) {
      throw new LocalLlmError("LOCAL_LLM_INVALID_REQUEST", "maxTokens must be between 1 and 8192");
    }

    this.model = options.model;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs;
    this.maxTokens = options.maxTokens;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async chat(request: LocalLlmChatRequest): Promise<string> {
    if (request.messages.length === 0) {
      throw new LocalLlmError("LOCAL_LLM_INVALID_REQUEST", "at least one message is required");
    }
    const temperature = request.temperature ?? 0.1;
    const maxTokens = request.maxTokens ?? this.maxTokens;
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
      throw new LocalLlmError("LOCAL_LLM_INVALID_REQUEST", "temperature must be between 0 and 2");
    }
    if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > this.maxTokens) {
      throw new LocalLlmError("LOCAL_LLM_INVALID_REQUEST", "maxTokens must be between 1 and " + this.maxTokens);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(this.baseUrl + "/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          messages: request.messages,
          temperature,
          max_tokens: maxTokens,
          stream: false,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timeout);
      if (controller.signal.aborted) {
        throw new LocalLlmError("LOCAL_LLM_TIMEOUT", "model request exceeded " + this.timeoutMs + "ms");
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new LocalLlmError("LOCAL_LLM_UNAVAILABLE", "could not reach the local model server: " + detail.slice(0, 240));
    }

    let body: string;
    try {
      body = await response.text();
    } catch {
      if (controller.signal.aborted) {
        throw new LocalLlmError("LOCAL_LLM_TIMEOUT", "model response exceeded " + this.timeoutMs + "ms");
      }
      throw new LocalLlmError("LOCAL_LLM_INVALID_RESPONSE", "could not read the local model response");
    } finally {
      clearTimeout(timeout);
    }
    if (body.length > MAX_RESPONSE_CHARS) {
      throw new LocalLlmError("LOCAL_LLM_INVALID_RESPONSE", "local model response exceeded the size limit");
    }
    if (!response.ok) {
      const detail = responseDetail(body);
      throw new LocalLlmError(
        "LOCAL_LLM_HTTP_ERROR",
        "local model server returned HTTP " + response.status + (detail ? ": " + detail : ""),
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body) as unknown;
    } catch {
      throw new LocalLlmError("LOCAL_LLM_INVALID_RESPONSE", "local model returned invalid JSON");
    }
    const validated = chatResponseSchema.safeParse(parsed);
    if (!validated.success) {
      throw new LocalLlmError("LOCAL_LLM_INVALID_RESPONSE", "local model response did not contain choices[0].message.content");
    }
    const content = validated.data.choices[0]?.message.content.trim();
    if (!content) {
      throw new LocalLlmError("LOCAL_LLM_INVALID_RESPONSE", "local model returned an empty answer");
    }
    return content;
  }
}
