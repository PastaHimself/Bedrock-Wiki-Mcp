import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  localLlmServerArguments,
  startLocalLlmServer,
  tryStartLocalLlmServer,
  type LocalLlmChild,
} from "../../src/ai/local-server.js";

describe("local llama-server startup", () => {
  it("builds a loopback command that asks llama-server to fetch the model", () => {
    expect(localLlmServerArguments(
      "http://127.0.0.1:8081/v1",
      "Qwen/Qwen3-1.7B-GGUF:Q8_0",
    )).toEqual([
      "-hf", "Qwen/Qwen3-1.7B-GGUF:Q8_0",
      "--host", "127.0.0.1",
      "--port", "8081",
      "--ctx-size", "4096",
      "--threads", "2",
      "--threads-batch", "2",
      "--threads-http", "1",
      "--parallel", "1",
    ]);
    expect(() => localLlmServerArguments(
      "https://example.com/v1",
      "qwen",
    )).toThrow("LOCAL_LLM_INVALID_REQUEST");
  });

  it("rejects thread counts outside the supported range", () => {
    expect(() => localLlmServerArguments(
      "http://127.0.0.1:8081/v1",
      "qwen",
      4096,
      0,
    )).toThrow("LOCAL_LLM_INVALID_REQUEST");
  });

  it("reuses a healthy local server without starting a second process", async () => {
    let spawnCalled = false;
    const handle = await startLocalLlmServer({
      baseUrl: "http://127.0.0.1:8081/v1",
      model: "Qwen/Qwen3-1.7B-GGUF:Q8_0",
      cacheDir: join(tmpdir(), "bedrock-qwen-test-cache-unused"),
      startupTimeoutMs: 10_000,
      fetchImpl: async () => new Response(null, { status: 200 }),
      spawnImpl: () => {
        spawnCalled = true;
        throw new Error("should not start when healthy");
      },
    });

    expect(handle.startedByProcess).toBe(false);
    expect(spawnCalled).toBe(false);
    await handle.stop();
  });

  it("starts llama-server with a persistent cache and waits for readiness", async () => {
    const parent = await mkdtemp(join(tmpdir(), "bedrock-qwen-start-"));
    const cacheDir = join(parent, "huggingface");
    let healthChecks = 0;
    let command = "";
    let args: readonly string[] = [];
    let cacheEnvironment = "";
    let killed: NodeJS.Signals | undefined;
    const child: LocalLlmChild = {
      once: () => child,
      kill: (signal) => {
        killed = signal;
        return true;
      },
    };

    try {
      const handle = await startLocalLlmServer({
        baseUrl: "http://127.0.0.1:8081/v1",
        model: "Qwen/Qwen3-1.7B-GGUF:Q8_0",
        binary: "/opt/llama-server",
        cacheDir,
        threads: 4,
        startupTimeoutMs: 10_000,
        fetchImpl: async () => {
          healthChecks += 1;
          return new Response(null, { status: healthChecks === 1 ? 503 : 200 });
        },
        spawnImpl: (spawnCommand, spawnArgs, options) => {
          command = spawnCommand;
          args = spawnArgs;
          cacheEnvironment = options.env.HF_HOME ?? "";
          return child;
        },
        sleepImpl: async () => undefined,
      });

      expect(command).toBe("/opt/llama-server");
      expect(args).toContain("-hf");
      expect(args).toContain("Qwen/Qwen3-1.7B-GGUF:Q8_0");
      expect(args).toContain("--host");
      expect(args).toContain("127.0.0.1");
      expect(args).toEqual(expect.arrayContaining([
        "--threads", "4",
        "--threads-batch", "4",
        "--threads-http", "1",
      ]));
      expect(cacheEnvironment).toBe(cacheDir);
      expect(handle.startedByProcess).toBe(true);

      await handle.stop();
      expect(killed).toBe("SIGTERM");
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("does not make the MCP unavailable when the optional runtime is missing", async () => {
    const warnings: string[] = [];
    const child: LocalLlmChild = {
      once: (event, listener) => {
        if (event === "error") {
          const onError = listener as (error: Error) => void;
          queueMicrotask(() => onError(Object.assign(new Error("spawn llama-server ENOENT"), { code: "ENOENT" })));
        }
        return child;
      },
      kill: () => true,
    };
    const handle = await tryStartLocalLlmServer({
      baseUrl: "http://127.0.0.1:8081/v1",
      model: "Qwen/Qwen3-1.7B-GGUF:Q8_0",
      cacheDir: join(tmpdir(), "bedrock-qwen-missing-runtime"),
      startupTimeoutMs: 10_000,
      fetchImpl: async () => new Response(null, { status: 503 }),
      sleepImpl: async () => undefined,
      spawnImpl: () => child,
    }, (error) => warnings.push(error.message));

    expect(handle).toBeUndefined();
    expect(warnings[0]).toContain("LOCAL_LLM_UNAVAILABLE");
  });
});
