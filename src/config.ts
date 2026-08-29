import { existsSync } from "node:fs";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { z } from "zod/v4";
import { isLoopbackLlmBaseUrl } from "./ai/local-llm.js";

const booleanStringSchema = z.enum(["true", "false"]).transform((value) => value === "true");

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  BEDROCK_MCP_HOST: z.string().trim().min(1).default("127.0.0.1"),
  BEDROCK_MCP_PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
  BEDROCK_MCP_DATA_DIR: z.string().trim().min(1).default("./data"),
  BEDROCK_MCP_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  BEDROCK_MCP_ALLOWED_HOSTS: z.string().default(""),
  BEDROCK_MCP_ALLOWED_ORIGINS: z.string().default(""),
  BEDROCK_MCP_TRUSTED_PROXY_IPS: z.string().default(""),
  BEDROCK_MCP_BEARER_TOKEN: z.string().min(16).max(4096).optional(),
  BEDROCK_MCP_MAX_REQUEST_BYTES: z.coerce.number().int().min(16_384).max(4_194_304).default(524_288),
  BEDROCK_MCP_MAX_CONCURRENT_REQUESTS: z.coerce.number().int().min(1).max(512).default(32),
  BEDROCK_MCP_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(10_000).default(120),
  BEDROCK_MCP_INCLUDE_PREVIEW: booleanStringSchema.default(false),
  BEDROCK_MCP_SEMANTIC_ENABLED: booleanStringSchema.default(false),
  BEDROCK_MCP_SEMANTIC_MODEL: z.string().trim().min(1).max(300).default("onnx-community/all-MiniLM-L6-v2-ONNX"),
  BEDROCK_MCP_SEMANTIC_TOP_K: z.coerce.number().int().min(5).max(100).default(40),
  BEDROCK_MCP_LOCAL_LLM_ENABLED: booleanStringSchema.default(true),
  BEDROCK_MCP_LOCAL_LLM_BASE_URL: z.string().trim().url().refine(
    isLoopbackLlmBaseUrl,
    "BEDROCK_MCP_LOCAL_LLM_BASE_URL must point to a loopback HTTP endpoint",
  ).default("http://127.0.0.1:8081/v1"),
  BEDROCK_MCP_LOCAL_LLM_BINARY: z.string().trim().min(1).max(300).default("llama-server"),
  BEDROCK_MCP_LOCAL_LLM_MODEL: z.string().trim().min(1).max(300).default("Qwen/Qwen3-1.7B-GGUF:Q8_0"),
  BEDROCK_MCP_LOCAL_LLM_THREADS: z.coerce.number().int().min(1).max(32).default(2),
  BEDROCK_MCP_LOCAL_LLM_STARTUP_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(1_800_000).default(900_000),
  BEDROCK_MCP_LOCAL_LLM_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(60_000),
  BEDROCK_MCP_LOCAL_LLM_MAX_TOKENS: z.coerce.number().int().min(64).max(512).default(512),
  BEDROCK_MCP_LOCAL_LLM_RETRIEVAL_LIMIT: z.coerce.number().int().min(1).max(8).default(6),
});

export interface AppConfig {
  readonly nodeEnv: "development" | "test" | "production";
  readonly host: string;
  readonly port: number;
  readonly dataDir: string;
  readonly logLevel: "debug" | "info" | "warn" | "error";
  readonly allowedHosts: readonly string[];
  readonly allowedOrigins: readonly string[];
  readonly trustedProxyIps: readonly string[];
  readonly bearerToken?: string;
  readonly maxRequestBodySize: number;
  readonly maxConcurrentRequests: number;
  readonly rateLimitPerMinute: number;
  /** Optional for backwards-compatible programmatic AppConfig fixtures; loadConfig always populates it. */
  readonly includePreview?: boolean;
  readonly semanticEnabled: boolean;
  readonly semanticModel: string;
  readonly semanticTopK: number;
  readonly localLlmEnabled: boolean;
  readonly localLlmBaseUrl: string;
  readonly localLlmBinary: string;
  readonly localLlmModel: string;
  readonly localLlmThreads: number;
  readonly localLlmStartupTimeoutMs: number;
  readonly localLlmTimeoutMs: number;
  readonly localLlmMaxTokens: number;
  readonly localLlmRetrievalLimit: number;
}

function csvValues(value: string, normalize: (entry: string) => string = (entry) => entry): string[] {
  return [...new Set(value.split(",").map((entry) => normalize(entry.trim())).filter(Boolean))];
}

function trustedProxyIps(value: string): string[] {
  const entries = csvValues(value);
  const invalid = entries.find((entry) => isIP(entry) === 0);
  if (invalid) throw new Error(`BEDROCK_MCP_TRUSTED_PROXY_IPS contains an invalid IP address: ${invalid}`);
  return entries;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): AppConfig {
  const parsed = environmentSchema.parse(env);

  return {
    nodeEnv: parsed.NODE_ENV,
    host: parsed.BEDROCK_MCP_HOST,
    port: parsed.BEDROCK_MCP_PORT,
    dataDir: resolve(cwd, parsed.BEDROCK_MCP_DATA_DIR),
    logLevel: parsed.BEDROCK_MCP_LOG_LEVEL,
    allowedHosts: csvValues(parsed.BEDROCK_MCP_ALLOWED_HOSTS, (entry) => entry.toLocaleLowerCase()),
    allowedOrigins: csvValues(parsed.BEDROCK_MCP_ALLOWED_ORIGINS, (entry) => entry.replace(/\/$/, "")),
    trustedProxyIps: trustedProxyIps(parsed.BEDROCK_MCP_TRUSTED_PROXY_IPS),
    ...(parsed.BEDROCK_MCP_BEARER_TOKEN ? { bearerToken: parsed.BEDROCK_MCP_BEARER_TOKEN } : {}),
    maxRequestBodySize: parsed.BEDROCK_MCP_MAX_REQUEST_BYTES,
    maxConcurrentRequests: parsed.BEDROCK_MCP_MAX_CONCURRENT_REQUESTS,
    rateLimitPerMinute: parsed.BEDROCK_MCP_RATE_LIMIT_PER_MINUTE,
    includePreview: parsed.BEDROCK_MCP_INCLUDE_PREVIEW,
    semanticEnabled: parsed.BEDROCK_MCP_SEMANTIC_ENABLED,
    semanticModel: parsed.BEDROCK_MCP_SEMANTIC_MODEL,
    semanticTopK: parsed.BEDROCK_MCP_SEMANTIC_TOP_K,
    localLlmEnabled: parsed.BEDROCK_MCP_LOCAL_LLM_ENABLED,
    localLlmBaseUrl: parsed.BEDROCK_MCP_LOCAL_LLM_BASE_URL,
    localLlmBinary: parsed.BEDROCK_MCP_LOCAL_LLM_BINARY,
    localLlmModel: parsed.BEDROCK_MCP_LOCAL_LLM_MODEL,
    localLlmThreads: parsed.BEDROCK_MCP_LOCAL_LLM_THREADS,
    localLlmStartupTimeoutMs: parsed.BEDROCK_MCP_LOCAL_LLM_STARTUP_TIMEOUT_MS,
    localLlmTimeoutMs: parsed.BEDROCK_MCP_LOCAL_LLM_TIMEOUT_MS,
    localLlmMaxTokens: parsed.BEDROCK_MCP_LOCAL_LLM_MAX_TOKENS,
    localLlmRetrievalLimit: parsed.BEDROCK_MCP_LOCAL_LLM_RETRIEVAL_LIMIT,
  };
}

export function loadRuntimeConfig(envFile = ".env"): AppConfig {
  if (existsSync(envFile)) {
    loadEnvFile(envFile);
  }

  return loadConfig();
}
