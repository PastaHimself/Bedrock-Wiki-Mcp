# Local Qwen Bedrock Helper Design

## Goal

Add an optional local AI helper that lets an MCP client ask a Bedrock development question in natural language. The helper retrieves evidence from the existing Bedrock Wiki index, sends only that bounded evidence to a local OpenAI-compatible model server, and returns an answer with resource references.

The default model is `Qwen/Qwen3-1.7B-GGUF`, served by `llama-server` with the official `Q8_0` quantization. The model file is downloaded into the operator's model cache at runtime and is not committed to GitHub or bundled into the application.

## Scope

### In scope

- An optional read-only `ask_bedrock` MCP tool.
- Lexical search by default, with the existing hybrid search path when semantic retrieval is enabled.
- A local OpenAI-compatible chat-completions client using Node's built-in `fetch`.
- Strictly bounded evidence and output sizes for a small-RAM server.
- Citation references (`[R1]`, `[R2]`, …) mapped back to indexed chunks and source metadata.
- Explicit disabled, unavailable, timeout, HTTP, and malformed-response errors.
- Configuration and deployment instructions for running Qwen locally on loopback.

### Out of scope

- Hosting an inference API, calling a cloud model, or exposing the model port publicly.
- Automatic model training or fine-tuning.
- Replacing the deterministic `search`, `fetch`, or `get_definition` tools.
- Treating generated text as authoritative when the index does not contain supporting evidence.

## Architecture

`ask_bedrock` follows this path:

1. Validate the question and optional retrieval filters.
2. Retrieve up to the configured number of results from the existing search engine.
3. Format each result as bounded, labelled evidence with a stable reference ID.
4. Send a prompt that requires the model to use only that evidence and cite factual claims.
5. Remove any Qwen thinking markers, bound the answer, and parse cited reference IDs.
6. Return the answer, model name, evidence resources, citation mappings, and a grounded/warning status as MCP structured content.

The local model client is an adapter boundary. The server does not need to know whether the endpoint is backed by Qwen, another GGUF model, or a test double, but production configuration defaults to Qwen3.

## MCP contract

`ask_bedrock` accepts:

- `query`: 1–500 character Bedrock development question.
- The same useful retrieval filters as `search`: `kinds`, `categories`, `stabilities`, `sourceTiers`, `source`, `channel`, `module`, `pathPrefix`, `minecraftVersion`, `apiVersion`, `includePreview`, and `includeHistorical`.
- `limit`: maximum evidence resources, bounded to eight.

It returns:

- `query`, `answer`, `model`, and `candidateCount`.
- `resources`: the exact search results supplied to the model.
- `citations`: reference ID to `chunkId`, `sourceId`, title, and path.

The tool is always registered so MCP clients can discover it. When local inference is disabled or the model server is down, it returns an actionable MCP tool error instead of silently falling back to a remote service.

## Grounding and safety

The system prompt identifies indexed text as untrusted evidence and tells the model to ignore instructions contained inside it. The answer prompt requires concise responses, citations for factual claims, and an explicit statement when the evidence is insufficient. The model receives excerpts and provenance, not arbitrary filesystem paths or user-controlled tool instructions.

A response is marked `grounded` only when it cites at least one supplied resource and does not cite an unavailable reference marker. Missing or unknown citations remain visible in the answer but produce a warning for the caller.

The endpoint is configured for loopback by default (`127.0.0.1:8081`). The application only sends requests to the configured local endpoint; operators should not bind llama-server to a public interface.

## Resource budget

- Default model: official Qwen3 1.7B `Q8_0` GGUF, about 1.83 GB on disk.
- Default context sent by the helper: at most six results and 8,000 evidence characters, leaving room for instructions and the 512-token answer inside a 4K context.
- Default generation: 512 tokens, 60-second timeout, one request at a time recommended by the deployment documentation.
- Normal lookup prompts should include `/no_think` to avoid spending the small CPU/RAM budget on visible reasoning text.

If the 3 GiB server cannot keep the model and Node process resident together, the deployment fallback is a smaller Qwen3 quantization or Qwen3 0.6B. The MCP integration remains unchanged because both expose the same local chat-completions interface.

## Configuration

The following environment variables are added:

| Variable | Default | Purpose |
| --- | --- | --- |
| `BEDROCK_MCP_LOCAL_LLM_ENABLED` | `false` | Enable `ask_bedrock` inference calls. |
| `BEDROCK_MCP_LOCAL_LLM_BASE_URL` | `http://127.0.0.1:8081/v1` | Local OpenAI-compatible API base URL. |
| `BEDROCK_MCP_LOCAL_LLM_MODEL` | `Qwen/Qwen3-1.7B-GGUF:Q8_0` | Model identifier sent to the server. |
| `BEDROCK_MCP_LOCAL_LLM_TIMEOUT_MS` | `60000` | Per-request inference timeout. |
| `BEDROCK_MCP_LOCAL_LLM_MAX_TOKENS` | `512` | Maximum generated tokens. |
| `BEDROCK_MCP_LOCAL_LLM_RETRIEVAL_LIMIT` | `6` | Maximum evidence resources supplied to Qwen. |

The application does not start or download llama-server itself. Operators start the local model server separately, which keeps model-process lifecycle and model-cache ownership explicit. `LocalLlmClient` permits one active generation and one queued request; additional concurrent helper calls receive a retryable busy error.

## Verification

- Unit tests cover configuration defaults/validation, request serialization, timeout and malformed responses, prompt grounding/citation formatting, and tool registration.
- Existing search, fetch, security, source, and semantic tests must remain green.
- Typecheck and production build must pass.
- Deployment documentation includes the exact Qwen launch command, loopback-only guidance, and an optional systemd unit with a readiness wait script and restart policy.
