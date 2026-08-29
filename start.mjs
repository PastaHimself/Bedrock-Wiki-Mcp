import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync, spawn } from "node:child_process";
import { join } from "node:path";

process.chdir("/home/container");

process.env.NODE_ENV ??= "production";
process.env.BEDROCK_MCP_HOST ??= "0.0.0.0";
process.env.BEDROCK_MCP_PORT ??= process.env.SERVER_PORT ?? process.env.PORT ?? "8080";
process.env.BEDROCK_MCP_DATA_DIR ??= "/home/container/data";
process.env.BEDROCK_MCP_SEMANTIC_ENABLED ??= "false";
process.env.BEDROCK_MCP_MAX_CONCURRENT_REQUESTS ??= "8";
process.env.BEDROCK_MCP_LOCAL_LLM_ENABLED ??= "true";
process.env.BEDROCK_MCP_LOCAL_LLM_STARTUP_TIMEOUT_MS ??= "900000";

const LLAMA_INSTALL_URL = "https://llama.app/install.sh";
const LLAMA_RUNTIME_ROOT = join(process.env.BEDROCK_MCP_DATA_DIR, "llama-runtime");
const LLAMA_RUNTIME_HOME = join(LLAMA_RUNTIME_ROOT, "home");
const LLAMA_BINARY = join(LLAMA_RUNTIME_HOME, ".local", "bin", "llama");
const LLAMA_SERVER_WRAPPER = join(LLAMA_RUNTIME_ROOT, "llama-server");
const LLAMA_CACHE = join(process.env.BEDROCK_MCP_DATA_DIR, "models", "huggingface");

function run(command, args) {
  console.log(`[startup] ${command} ${args.join(" ")}`);

  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: process.env,
  });

  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function commandWorks(command) {
  const result = spawnSync(command, ["--version"], {
    stdio: "ignore",
    env: process.env,
  });
  return !result.error;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function downloadText(url) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`download failed with HTTP ${response.status}: ${url}`);
  return response.text();
}

function configureLlama(binary) {
  process.env.BEDROCK_MCP_LOCAL_LLM_BINARY = binary;
  process.env.LLAMA_CACHE = LLAMA_CACHE;
  process.env.HF_HOME = LLAMA_CACHE;
  console.log(`[startup] Using local llama runtime at ${binary}`);
}

async function ensureLocalLlmRuntime() {
  if (process.env.BEDROCK_MCP_LOCAL_LLM_ENABLED === "false") return;

  const configuredBinary = process.env.BEDROCK_MCP_LOCAL_LLM_BINARY?.trim();
  if (configuredBinary && configuredBinary !== "llama-server" && commandWorks(configuredBinary)) {
    configureLlama(configuredBinary);
    return;
  }
  if ((!configuredBinary || configuredBinary === "llama-server") && commandWorks("llama-server")) {
    configureLlama("llama-server");
    return;
  }

  if (!existsSync(LLAMA_SERVER_WRAPPER)) {
    const installerPath = join(LLAMA_RUNTIME_ROOT, "install.sh");
    mkdirSync(LLAMA_RUNTIME_HOME, { recursive: true });
    writeFileSync(installerPath, await downloadText(LLAMA_INSTALL_URL), { mode: 0o700 });

    try {
      console.log("[startup] Installing llama.cpp from the Hugging Face-backed installer...");
      const result = spawnSync("/bin/sh", [installerPath], {
        stdio: "inherit",
        env: {
          ...process.env,
          HOME: LLAMA_RUNTIME_HOME,
          SKIP_CUDA: "1",
          SKIP_ROCM: "1",
          SKIP_VULKAN: "1",
        },
      });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`llama.cpp installer exited with code ${result.status}`);
      if (!existsSync(LLAMA_BINARY)) throw new Error("llama.cpp installer did not create the llama binary");

      writeFileSync(
        LLAMA_SERVER_WRAPPER,
        `#!/bin/sh\nexec ${shellQuote(LLAMA_BINARY)} serve "$@"\n`,
        { mode: 0o755 },
      );
      chmodSync(LLAMA_SERVER_WRAPPER, 0o755);
    } finally {
      rmSync(installerPath, { force: true });
    }
  }

  configureLlama(LLAMA_SERVER_WRAPPER);
}

async function main() {
  try {
    await ensureLocalLlmRuntime();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[startup] Local Qwen runtime unavailable; MCP will start without AI answers: ${detail}`);
  }

  if (!existsSync("/home/container/node_modules") ||
      !existsSync("/home/container/dist/index.js")) {
    console.log("[startup] Installing dependencies...");
    run("npm", ["ci", "--include=dev", "--omit=optional"]);

    console.log("[startup] Building MCP...");
    run("npm", ["run", "build"]);
  }

  if (!existsSync("/home/container/data/index/bedrock.db")) {
    console.log("[startup] No knowledge index found.");

    console.log("[startup] Downloading Bedrock sources...");
    run(process.execPath, ["dist/index.js", "sync-sources"]);

    console.log("[startup] Building knowledge index...");
    run(process.execPath, ["dist/index.js", "rebuild-sources"]);
  }

  console.log("[startup] Starting Bedrock Wiki MCP...");

  const server = spawn(
    process.execPath,
    ["dist/index.js", "serve"],
    {
      stdio: "inherit",
      env: process.env,
    },
  );

  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => server.kill(signal));
  }

  server.on("exit", (code) => {
    process.exit(code ?? 0);
  });
}

await main();
