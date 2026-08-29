import { existsSync } from "node:fs";
import { spawnSync, spawn } from "node:child_process";

process.chdir("/home/container");

process.env.NODE_ENV ??= "production";
process.env.BEDROCK_MCP_HOST ??= "0.0.0.0";
process.env.BEDROCK_MCP_PORT ??= process.env.SERVER_PORT ?? process.env.PORT ?? "8080";
process.env.BEDROCK_MCP_DATA_DIR ??= "/home/container/data";
process.env.BEDROCK_MCP_SEMANTIC_ENABLED ??= "false";
process.env.BEDROCK_MCP_MAX_CONCURRENT_REQUESTS ??= "8";

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

async function main() {
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
