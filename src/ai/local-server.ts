import { mkdir } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { LocalLlmError, isLoopbackLlmBaseUrl } from "./local-llm.js";

const HEALTH_CHECK_TIMEOUT_MS = 2_000;
const HEALTH_CHECK_INTERVAL_MS = 1_000;

export interface LocalLlmChild {
  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface LocalLlmServerOptions {
  readonly baseUrl: string;
  readonly model: string;
  readonly binary?: string;
  readonly cacheDir: string;
  readonly contextSize?: number;
  readonly threads?: number;
  readonly startupTimeoutMs: number;
  readonly fetchImpl?: typeof fetch;
  readonly spawnImpl?: (command: string, args: readonly string[], options: {
    env: NodeJS.ProcessEnv;
    stdio: ["ignore", "inherit", "inherit"];
  }) => LocalLlmChild;
  readonly sleepImpl?: (milliseconds: number) => Promise<void>;
}

export interface LocalLlmServerHandle {
  readonly startedByProcess: boolean;
  stop(): Promise<void>;
}

function serverAddress(baseUrl: string): { healthUrl: string; host: string; port: string } {
  if (!isLoopbackLlmBaseUrl(baseUrl)) {
    throw new LocalLlmError(
      "LOCAL_LLM_INVALID_REQUEST",
      "the local model endpoint must use http://localhost, http://127.0.0.1, or http://[::1]",
    );
  }

  const url = new URL(baseUrl);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const port = url.port || "80";
  return {
    healthUrl: url.origin + "/health",
    host,
    port,
  };
}

function defaultSpawn(
  command: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; stdio: ["ignore", "inherit", "inherit"] },
): ChildProcess {
  return spawn(command, args, options);
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function isReady(fetchImpl: typeof fetch, healthUrl: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);
  try {
    const response = await fetchImpl(healthUrl, {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
    });
    if (response.body) await response.body.cancel().catch(() => undefined);
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function waitUntilReady(
  fetchImpl: typeof fetch,
  healthUrl: string,
  timeoutMs: number,
  childFailure: () => Error | undefined,
  sleepImpl: (milliseconds: number) => Promise<void>,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const failure = childFailure();
    if (failure) {
      throw new LocalLlmError(
        "LOCAL_LLM_UNAVAILABLE",
        "llama-server exited before becoming ready: " + failure.message.slice(0, 240),
      );
    }
    if (await isReady(fetchImpl, healthUrl)) return;
    await sleepImpl(Math.min(HEALTH_CHECK_INTERVAL_MS, Math.max(1, deadline - Date.now())));
  }
  throw new LocalLlmError(
    "LOCAL_LLM_TIMEOUT",
    "llama-server did not become ready within " + timeoutMs + "ms",
  );
}

export function localLlmServerArguments(
  baseUrl: string,
  model: string,
  contextSize = 4_096,
  threads = 2,
): readonly string[] {
  const { host, port } = serverAddress(baseUrl);
  if (!Number.isSafeInteger(contextSize) || contextSize < 1_024 || contextSize > 32_768) {
    throw new LocalLlmError("LOCAL_LLM_INVALID_REQUEST", "contextSize must be between 1024 and 32768");
  }
  if (!Number.isSafeInteger(threads) || threads < 1 || threads > 32) {
    throw new LocalLlmError("LOCAL_LLM_INVALID_REQUEST", "threads must be between 1 and 32");
  }
  return [
    "-hf", model,
    "--host", host,
    "--port", port,
    "--ctx-size", String(contextSize),
    "--threads", String(threads),
    "--threads-batch", String(threads),
    // llama-server otherwise sizes its HTTP pool from the host CPU count. On
    // Pterodactyl this can exceed the container PID/thread limit before the
    // model has even finished loading. The endpoint is loopback-only and the
    // MCP runs one inference slot, so one HTTP worker is sufficient.
    "--threads-http", "1",
    "--parallel", "1",
  ];
}

export async function startLocalLlmServer(options: LocalLlmServerOptions): Promise<LocalLlmServerHandle> {
  const { healthUrl } = serverAddress(options.baseUrl);
  if (!Number.isSafeInteger(options.startupTimeoutMs) || options.startupTimeoutMs < 10_000 || options.startupTimeoutMs > 1_800_000) {
    throw new LocalLlmError("LOCAL_LLM_INVALID_REQUEST", "startupTimeoutMs must be between 10000 and 1800000");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  if (await isReady(fetchImpl, healthUrl)) {
    return {
      startedByProcess: false,
      stop: async () => undefined,
    };
  }

  await mkdir(options.cacheDir, { recursive: true });
  const command = options.binary?.trim() || "llama-server";
  const args = localLlmServerArguments(options.baseUrl, options.model, options.contextSize, options.threads);
  let child: LocalLlmChild;
  try {
    child = (options.spawnImpl ?? defaultSpawn)(command, args, {
      env: { ...process.env, HF_HOME: options.cacheDir },
      stdio: ["ignore", "inherit", "inherit"],
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new LocalLlmError(
      "LOCAL_LLM_UNAVAILABLE",
      "could not start llama-server; install llama.cpp and ensure the binary is available: " + detail.slice(0, 240),
    );
  }

  let failure: Error | undefined;
  child.once("error", (error) => { failure = error; });
  child.once("exit", (code, signal) => {
    if (code !== 0 && !failure) {
      failure = new Error("exit=" + String(code) + (signal ? ", signal=" + signal : ""));
    }
  });

  try {
    await waitUntilReady(
      fetchImpl,
      healthUrl,
      options.startupTimeoutMs,
      () => failure,
      options.sleepImpl ?? sleep,
    );
  } catch (error) {
    child.kill("SIGTERM");
    throw error;
  }

  let stopped = false;
  return {
    startedByProcess: true,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      child.kill("SIGTERM");
    },
  };
}

export async function tryStartLocalLlmServer(
  options: LocalLlmServerOptions,
  onUnavailable?: (error: LocalLlmError) => void,
): Promise<LocalLlmServerHandle | undefined> {
  try {
    return await startLocalLlmServer(options);
  } catch (error) {
    if (error instanceof LocalLlmError
      && (error.code === "LOCAL_LLM_UNAVAILABLE" || error.code === "LOCAL_LLM_TIMEOUT")) {
      onUnavailable?.(error);
      return undefined;
    }
    throw error;
  }
}
