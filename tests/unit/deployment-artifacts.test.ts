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

  it("refreshes knowledge before restarting the server", async () => {
    const script = await text("deploy/scripts/update-knowledge.sh");
    const sync = script.indexOf("dist/index.js sync-sources");
    const rebuild = script.indexOf("dist/index.js rebuild-sources");
    const validate = script.indexOf("dist/index.js validate-index");
    expect(script).toContain("flock -n");
    expect(sync).toBeGreaterThan(0);
    expect(rebuild).toBeGreaterThan(sync);
    expect(validate).toBeGreaterThan(rebuild);

    const unit = await text("deploy/systemd/bedrock-mcp-update.service");
    expect(unit).toContain("runuser -u bedrock-mcp");
    expect(unit).toContain("update-knowledge.sh");
    expect(unit).toContain("ExecStartPost=/usr/bin/systemctl try-restart bedrock-mcp.service");
    expect(unit).toContain("ReadWritePaths=/var/lib/bedrock-mcp");
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
