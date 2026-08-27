import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { z } from "zod/v4";

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  BEDROCK_MCP_HOST: z.string().trim().min(1).default("127.0.0.1"),
  BEDROCK_MCP_PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
  BEDROCK_MCP_DATA_DIR: z.string().trim().min(1).default("./data"),
  BEDROCK_MCP_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  BEDROCK_MCP_ALLOWED_HOSTS: z.string().default(""),
  BEDROCK_MCP_ALLOWED_ORIGINS: z.string().default(""),
  BEDROCK_MCP_BEARER_TOKEN: z.string().min(16).max(4096).optional(),
  BEDROCK_MCP_MAX_REQUEST_BYTES: z.coerce.number().int().min(16_384).max(4_194_304).default(524_288),
  BEDROCK_MCP_MAX_CONCURRENT_REQUESTS: z.coerce.number().int().min(1).max(512).default(32),
  BEDROCK_MCP_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(10_000).default(120),
});

export interface AppConfig {
  readonly nodeEnv: "development" | "test" | "production";
  readonly host: string;
  readonly port: number;
  readonly dataDir: string;
  readonly logLevel: "debug" | "info" | "warn" | "error";
  readonly allowedHosts: readonly string[];
  readonly allowedOrigins: readonly string[];
  readonly bearerToken?: string;
  readonly maxRequestBodySize: number;
  readonly maxConcurrentRequests: number;
  readonly rateLimitPerMinute: number;
}

function csvValues(value: string, normalize: (entry: string) => string = (entry) => entry): string[] {
  return [...new Set(value.split(",").map((entry) => normalize(entry.trim())).filter(Boolean))];
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
    ...(parsed.BEDROCK_MCP_BEARER_TOKEN ? { bearerToken: parsed.BEDROCK_MCP_BEARER_TOKEN } : {}),
    maxRequestBodySize: parsed.BEDROCK_MCP_MAX_REQUEST_BYTES,
    maxConcurrentRequests: parsed.BEDROCK_MCP_MAX_CONCURRENT_REQUESTS,
    rateLimitPerMinute: parsed.BEDROCK_MCP_RATE_LIMIT_PER_MINUTE,
  };
}

export function loadRuntimeConfig(envFile = ".env"): AppConfig {
  if (existsSync(envFile)) {
    loadEnvFile(envFile);
  }

  return loadConfig();
}
