import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function text(path: string): Promise<string> {
  return readFile(path, "utf8");
}

describe("production deployment artifacts", () => {
  it("keeps the public systemd service unprivileged and read-only", async () => {
    const unit = await text("deploy/systemd/bedrock-mcp.service");
    expect(unit).toContain("User=bedrock-mcp");
    expect(unit).toContain("Group=bedrock-mcp");
    expect(unit).toContain("ExecStart=/usr/bin/node /opt/bedrock-wiki-mcp/dist/index.js serve");
    expect(unit).toContain("NoNewPrivileges=true");
    expect(unit).toContain("ProtectSystem=strict");
    expect(unit).toContain("ReadOnlyPaths=/var/lib/bedrock-mcp");
    expect(unit).not.toContain("0.0.0.0");
  });

  it("backs up, refreshes lexical/semantic knowledge, then restarts the server", async () => {
    const script = await text("deploy/scripts/update-knowledge.sh");
    const backup = script.indexOf("dist/index.js backup");
    const sync = script.indexOf("dist/index.js sync-sources");
    const rebuild = script.indexOf("dist/index.js rebuild-sources");
    const validate = script.indexOf("dist/index.js validate-index");
    const semantic = script.indexOf("dist/index.js build-semantic-index");
    expect(script).toContain("flock -n");
    expect(script).toContain("BEDROCK_MCP_SEMANTIC_ENABLED");
    expect(script).toContain("BEDROCK_MCP_BACKUP_RETAIN");
    expect(script).toContain("BEDROCK_MCP_MIN_FREE_BYTES");
    expect(script).toContain("df -B1 --output=avail");
    expect(script).toContain("require_free_space \"before lexical rebuild\"");
    expect(backup).toBeGreaterThan(0);
    expect(sync).toBeGreaterThan(backup);
    expect(rebuild).toBeGreaterThan(sync);
    expect(validate).toBeGreaterThan(rebuild);
    expect(semantic).toBeGreaterThan(validate);

    const unit = await text("deploy/systemd/bedrock-mcp-update.service");
    expect(unit).toContain("runuser -u bedrock-mcp");
    expect(unit).toContain("update-knowledge.sh");
    expect(unit).toContain("ExecStartPost=/usr/bin/systemctl try-restart bedrock-mcp.service");
    expect(unit).toContain("TimeoutStartSec=2h");
    expect(unit).toContain("ReadWritePaths=/var/lib/bedrock-mcp");

    const environment = await text("deploy/systemd/bedrock-mcp.env.example");
    expect(environment).toContain("BEDROCK_MCP_TRUSTED_PROXY_IPS=");
    expect(environment).toContain("BEDROCK_MCP_MAX_CONCURRENT_REQUESTS=8");
    expect(environment).toContain("BEDROCK_MCP_SEMANTIC_ENABLED=false");
    expect(environment).toContain("BEDROCK_MCP_SEMANTIC_MODEL=onnx-community/all-MiniLM-L6-v2-ONNX");
    expect(environment).toContain("BEDROCK_MCP_BACKUP_RETAIN=3");
    expect(environment).toContain("BEDROCK_MCP_MIN_FREE_BYTES=2147483648");
  });

  it("uses blobless partial clones without narrowing source coverage", async () => {
    const sourceSync = await text("src/sources/sync.ts");
    expect(sourceSync).toContain("--filter=blob:none");
    expect(sourceSync).toContain("--single-branch");
    expect(sourceSync).not.toContain("sparse-checkout");
  });

  it("documents Cloudflare Tunnel client-IP trust without enabling generic proxy trust", async () => {
    const environment = await text("deploy/systemd/bedrock-mcp.env.example");
    expect(environment).toContain("BEDROCK_MCP_TRUSTED_PROXY_IPS=\n");

    const vps = await text("deploy/VPS.md");
    expect(vps).toContain("BEDROCK_MCP_TRUSTED_PROXY_IPS=127.0.0.1");
    expect(vps).toContain("CF-Connecting-IP");
    expect(vps).toContain("Do not copy that setting into an unrelated local proxy topology");
    expect(vps).toContain("attacker-supplied `CF-Connecting-IP` unchanged");
  });

  it("uses a persistent but jittered systemd timer", async () => {
    const timer = await text("deploy/systemd/bedrock-mcp-update.timer");
    expect(timer).toContain("OnCalendar=");
    expect(timer).toContain("Persistent=true");
    expect(timer).toContain("RandomizedDelaySec=");
    expect(timer).toContain("Unit=bedrock-mcp-update.service");
  });

  it("keeps reverse-proxy and tunnel origins on loopback", async () => {
    const caddy = await text("deploy/caddy/Caddyfile.example");
    expect(caddy).toContain("reverse_proxy 127.0.0.1:8080");

    const tunnel = await text("deploy/cloudflare/config.yml.example");
    expect(tunnel).toContain("service: http://127.0.0.1:8080");
    expect(tunnel).toContain("service: http_status:404");
  });

  it("documents Pterodactyl persistence and allocated-port binding", async () => {
    const guide = await text("deploy/README.md");
    expect(guide).toContain("BEDROCK_MCP_DATA_DIR=/home/container/data");
    expect(guide).toContain("BEDROCK_MCP_HOST=0.0.0.0");
    expect(guide).toContain("BEDROCK_MCP_PORT=<allocated panel port>");
    expect(guide).toContain("node dist/index.js serve");
  });
});
