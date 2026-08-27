import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

async function text(path: string): Promise<string> {
  return readFile(path, "utf8");
}

function expectBashSyntax(path: string): void {
  const result = spawnSync("bash", ["-n", path], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
}

describe("small VPS deployment workflow", () => {
  it("ships syntax-valid Ubuntu bootstrap and production verifier scripts", () => {
    expectBashSyntax("deploy/scripts/bootstrap-ubuntu.sh");
    expectBashSyntax("deploy/scripts/verify-production.sh");
  });

  it("builds a fixed-layout lexical-only runtime from an exact clean revision", async () => {
    const bootstrap = await text("deploy/scripts/bootstrap-ubuntu.sh");

    expect(bootstrap).toContain('APP_DIR="/opt/bedrock-wiki-mcp"');
    expect(bootstrap).toContain('DATA_DIR="/var/lib/bedrock-mcp"');
    expect(bootstrap).toContain('CONFIG_DIR="/etc/bedrock-mcp"');
    expect(bootstrap).toContain('SOURCE_USER="${SUDO_USER:-$(stat -c');
    expect(bootstrap).toContain("runuser -u \"$SOURCE_USER\" -- git");
    expect(bootstrap).toContain("run_source_git -C \"$REPO_ROOT\" status --porcelain");
    expect(bootstrap).toContain("run_source_git -C \"$REPO_ROOT\" archive HEAD");
    expect(bootstrap).toContain("rather than weakening Git safe.directory");
    expect(bootstrap).not.toMatch(/git\s+config[^\n]*safe\.directory/);
    expect(bootstrap).toContain("node_24.x");
    expect(bootstrap).toContain("signed-by=/etc/apt/keyrings/nodesource.gpg");
    expect(bootstrap).toContain("/usr/bin/npm ci --omit=optional");
    expect(bootstrap).toContain("/usr/bin/npm run build");
    expect(bootstrap).toContain("/usr/bin/npm prune --omit=dev --omit=optional");
    expect(bootstrap).toContain("test ! -e node_modules/sqlite-vec");
    expect(bootstrap).toContain("test ! -e node_modules/@huggingface/transformers");
    expect(bootstrap).toContain("token-safe characters");
    expect(bootstrap).toContain("BEDROCK_MCP_TRUSTED_PROXY_IPS=127.0.0.1");
    expect(bootstrap).toContain('"$STAGE_DIR/dist/index.js" status --json');
    expect(bootstrap).not.toContain('"$STAGE_DIR/dist/index.js" validate-index');
    expect(bootstrap).toContain("systemctl start bedrock-mcp-update.service");
    expect(bootstrap).toContain("systemctl enable --now bedrock-mcp.service");
    expect(bootstrap).toContain("systemctl enable --now bedrock-mcp-update.timer");
    expect(bootstrap).not.toContain("0.0.0.0");
  });

  it("verifies the actual loopback listener, MCP exchange, index, disk, and Tunnel", async () => {
    const verifier = await text("deploy/scripts/verify-production.sh");

    expect(verifier).toContain('APP_DIR="/opt/bedrock-wiki-mcp"');
    expect(verifier).toContain('CONFIG_FILE="/etc/bedrock-mcp/bedrock-mcp.env"');
    expect(verifier).toContain("read_env_value()");
    expect(verifier).not.toContain('source "$CONFIG_FILE"');
    expect(verifier).toContain('[[ "$NODE_MAJOR" == "24" ]]');
    expect(verifier).toContain('[[ "$DATA_DIR" == "/var/lib/bedrock-mcp" ]]');
    expect(verifier).toContain('[[ "$HOST" == "127.0.0.1" ]]');
    expect(verifier).toContain('[[ -n "$PRIMARY_HOST" ]]');
    expect(verifier).toContain('[[ "$TRUSTED_PROXIES" == "127.0.0.1" ]]');
    expect(verifier).toContain('[[ "$SEMANTIC_ENABLED" == "false" ]]');
    expect(verifier).toContain("ss -H -ltn");
    expect(verifier).toContain("status --json");
    expect(verifier).toContain('-H "Host: $host_header"');
    expect(verifier).toContain('"method":"initialize"');
    expect(verifier).toContain("df -B1 --output=avail");
    expect(verifier).toContain("cloudflared.service");
    expect(verifier).toContain('[[ "$PUBLIC_URL" == "https://$PRIMARY_HOST" ]]');
    expect(verifier).toContain('check_mcp "$PUBLIC_URL" "public HTTPS"');
  });

  it("documents the exact Tunnel package, DNS, service, and post-deploy sequence", async () => {
    const guide = await text("deploy/VPS.md");
    const cloudflare = await text("deploy/cloudflare/README.md");

    expect(guide).toContain("git checkout <validated-commit-sha-or-tag>");
    expect(guide).toContain("bash deploy/scripts/bootstrap-ubuntu.sh");
    expect(guide).toContain("cloudflared tunnel login");
    expect(guide).toContain("cloudflared tunnel create bedrock-mcp");
    expect(guide).toContain("cloudflared tunnel route dns bedrock-mcp");
    expect(guide).toContain("sudo cloudflared --config /etc/cloudflared/config.yml service install");
    expect(guide).toContain("sudo cloudflared tunnel ingress validate");
    expect(guide).toContain("BEDROCK_MCP_REQUIRE_CLOUDFLARED=true");
    expect(guide).toContain("BEDROCK_MCP_PUBLIC_URL=https://bedrock-mcp.example.com");
    expect(guide).toContain("/opt/bedrock-wiki-mcp/deploy/scripts/verify-production.sh");

    expect(cloudflare).toContain("https://pkg.cloudflare.com/cloudflare-main.gpg");
    expect(cloudflare).toContain("https://pkg.cloudflare.com/cloudflared any main");
    expect(cloudflare).toContain("sudo apt-get install -y cloudflared");
    expect(cloudflare).toContain("service: http://127.0.0.1:8080");
    expect(cloudflare).toContain("- service: http_status:404");
    expect(cloudflare).toContain("cloudflared tunnel route dns bedrock-mcp");
  });
});
