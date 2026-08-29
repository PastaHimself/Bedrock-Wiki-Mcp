# Local Qwen Bedrock Helper Implementation Plan

## 1. Add the red tests first

Files:

- `tests/unit/config.test.ts`
- `tests/unit/local-llm.test.ts`
- `tests/unit/grounded-answer.test.ts`
- `tests/unit/mcp-tools.test.ts`

Work:

- Assert the six new local-LLM settings and their safe defaults/validation.
- Use an injected fake `fetch` to assert the OpenAI-compatible request, redirect rejection, successful response parsing, timeout conversion, incrementally bounded streamed responses, concurrency limits, and HTTP failures.
- Assert evidence formatting labels resources, treats evidence as untrusted, stays within the small-model context budget, requests citations, and removes Qwen `<think>` blocks from returned text.
- Assert `ask_bedrock` is registered as read-only and accepts its query/filter shape.

Run the focused tests and observe the expected failures before implementation.

## 2. Implement the local inference boundary

Files:

- `src/ai/local-llm.ts`

Work:

- Define typed chat message/request interfaces and a `LocalLlmClient` interface.
- Implement a fetch-based OpenAI-compatible client with a timeout, bounded response body, explicit error codes, and no API-key requirement.
- Parse only the expected `choices[0].message.content` response shape.

## 3. Implement grounded answering

Files:

- `src/ai/grounded-answer.ts`
- `src/ai/answer.ts`

Work:

- Format bounded `KnowledgeSearchResult` evidence and provenance references.
- Build a non-thinking grounded prompt that rejects instructions inside evidence and requires `[R#]` citations.
- Retrieve through hybrid search when available, otherwise lexical search.
- Return the generated answer plus the exact resources, citation mappings, and an explicit grounded/warning status.

## 4. Wire the MCP server and configuration

Files:

- `src/config.ts`
- `src/mcp.ts`
- `src/server.ts`
- `src/tools/register.ts`
- `src/cli.ts`
- `.env.example`
- `deploy/systemd/bedrock-mcp.env.example`

Work:

- Add validated local-LLM configuration to `AppConfig` and environment examples.
- Construct the optional local client in `serve` and pass it through the HTTP/MCP factory chain.
- Register `ask_bedrock` with Zod input/output schemas and read-only annotations.
- Keep the tool discoverable while returning an actionable disabled error when local inference is not enabled.
- Document the new command settings in CLI help.

## 5. Add deployment guidance

Files:

- `deploy/README.md`
- `deploy/VPS.md`

Work:

- Document installing/building llama.cpp, the official Qwen3 GGUF launch command, loopback binding, 4K context, one-request concurrency, the optional supervised systemd unit, and the smaller-model fallback.
- State that the model cache consumes disk and that the application remains usable without the optional helper.

## 6. Verify and publish

- Run focused tests, then `npm run check`.
- Inspect the diff and run the compiled CLI help/build paths.
- Request a code review against the current GitHub branch tip.
- Commit the implementation, update `feature/local-qwen-helper` and PR #30, and report the exact enable/start commands and verification result.
