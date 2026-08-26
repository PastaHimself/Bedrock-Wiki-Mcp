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
});

export interface AppConfig {
  readonly nodeEnv: "development" | "test" | "production";
  readonly host: string;
  readonly port: number;
  readonly dataDir: string;
  readonly logLevel: "debug" | "info" | "warn" | "error";
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
  };
}

export function loadRuntimeConfig(envFile = ".env"): AppConfig {
  if (existsSync(envFile)) {
    loadEnvFile(envFile);
  }

  return loadConfig();
}
