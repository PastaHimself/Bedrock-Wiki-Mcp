import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

async function text(path: string): Promise<string> {
  return readFile(path, "utf8");
}

function expectBashSyntax(path: string): void {
  const result = spawnSync("bash", ["-n", path], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
}

const rootPrefix = process.getuid?.() === 0
  ? []
  : spawnSync("sudo", ["-n", "true"]).status === 0
    ? ["sudo", "-n"]
    : undefined;
const permissionTestUser = spawnSync("getent", ["passwd", "nobody"]).status === 0 ? "nobody" : undefined;

function runPrivileged(command: string, args: string[]) {
  if (!rootPrefix) return undefined;
  return rootPrefix.length === 0
    ? spawnSync(command, args, { encoding: "utf8" })
    : spawnSync(rootPrefix[0]!, [...rootPrefix.slice(1), command, ...args], { encoding: "utf8" });
}

const canSwitchUser = permissionTestUser !== undefined
  && runPrivileged("/usr/sbin/runuser", ["-u", permissionTestUser, "--", "/usr/bin/true"])?.status === 0;

describe("small VPS deployment workflow", () => {
  it("ships syntax-valid Ubuntu bootstrap and production verifier scripts", () => {
    expectBashSyntax("deploy/scripts/bootstrap-ubuntu.sh");
    expectBashSyntax("deploy/scripts/set-application-permissions.sh");
    expectBashSyntax("deploy/scripts/verify-production.sh");
  });

  it("provides the privilege harness required by CI for the real permission regression", () => {
    if (process.env.CI === "true" && process.platform === "linux") {
      expect(rootPrefix, "CI must provide passwordless sudo or run as root").toBeDefined();
      expect(permissionTestUser, "CI must provide the nobody account").toBeDefined();
      expect(canSwitchUser, "CI must permit runuser to execute as nobody").toBe(true);
    }
  });

  it.skipIf(process.platform !== "linux" || !canSwitchUser)(
    "makes a root-owned staged application readable but not writable by the service user",
    async () => {
      const application = await mkdtemp(join(tmpdir(), "bedrock-application-permissions-"));
      const updater = join(application, "deploy", "scripts", "update-knowledge.sh");
      const verifier = join(application, "deploy", "scripts", "verify-production.sh");
      const payload = join(application, "dist", "index.js");
      try {
        await mkdir(join(application, "deploy", "scripts"), { recursive: true });
        await mkdir(join(application, "dist"), { recursive: true });
        await writeFile(join(application, "package.json"), "{}\n", "utf8");
        await writeFile(updater, "#!/usr/bin/env bash\nexit 0\n", "utf8");
        await writeFile(verifier, "#!/usr/bin/env bash\nexit 0\n", "utf8");
        await writeFile(payload, "export {};\n", "utf8");
        await chmod(application, 0o700);
        await chmod(updater, 0o644);
        await chmod(verifier, 0o644);
        await chmod(payload, 0o666);

        const normalized = runPrivileged("/usr/bin/bash", [
          "deploy/scripts/set-application-permissions.sh",
          application,
          permissionTestUser!,
        ]);
        expect(normalized?.status, normalized?.stderr).toBe(0);

        const applicationInfo = await stat(application);
        const scriptsInfo = await stat(join(application, "deploy", "scripts"));
        const updaterInfo = await stat(updater);
        const payloadInfo = await stat(payload);
        expect(applicationInfo.uid).toBe(0);
        expect(applicationInfo.gid).toBe(0);
        expect(scriptsInfo.uid).toBe(0);
        expect(scriptsInfo.gid).toBe(0);
        expect(updaterInfo.uid).toBe(0);
        expect(updaterInfo.gid).toBe(0);
        expect(payloadInfo.uid).toBe(0);
        expect(payloadInfo.gid).toBe(0);
        expect(applicationInfo.mode & 0o777).toBe(0o755);
        expect(updaterInfo.mode & 0o777).toBe(0o755);
        expect(payloadInfo.mode & 0o777).toBe(0o644);

        for (const [command, path] of [["-x", application], ["-r", updater], ["-x", updater]] as const) {
          const access = runPrivileged("/usr/sbin/runuser", [
            "-u", permissionTestUser!, "--", "/usr/bin/test", command, path,
          ]);
          expect(access?.status, access?.stderr).toBe(0);
        }

        const createAttempt = runPrivileged("/usr/sbin/runuser", [
          "-u", permissionTestUser!, "--", "/usr/bin/mkdir", join(application, "dist", "forbidden"),
        ]);
        expect(createAttempt?.status).not.toBe(0);
        const writeAttempt = runPrivileged("/usr/sbin/runuser", [
          "-u", permissionTestUser!, "--", "/usr/bin/sh", "-c", 'printf x >> "$1"', "sh", payload,
        ]);
        expect(writeAttempt?.status).not.toBe(0);
      } finally {
        if (rootPrefix) {
          runPrivileged("/bin/chown", [
            "-R",
            `${String(process.getuid?.() ?? 0)}:${String(process.getgid?.() ?? 0)}`,
            application,
          ]);
        }
        await rm(application, { recursive: true, force: true });
      }
    },
  );

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
    expect(bootstrap).toContain('[[ ! -L "$CONFIG_DIR/bedrock-mcp.env" ]]');
    expect(bootstrap).toContain('chown root:"$SERVICE_USER" "$CONFIG_DIR/bedrock-mcp.env"');
    expect(bootstrap).toContain('chmod 0640 "$CONFIG_DIR/bedrock-mcp.env"');
    const stagedPermissions = bootstrap.indexOf(
      '"$STAGE_DIR/deploy/scripts/set-application-permissions.sh"',
    );
    const stagedStatus = bootstrap.indexOf('"$STAGE_DIR/dist/index.js" status --json');
    expect(stagedPermissions).toBeGreaterThan(-1);
    expect(stagedStatus).toBeGreaterThan(stagedPermissions);
    const applicationSwap = bootstrap.indexOf('mv -- "$STAGE_DIR" "$APP_DIR"');
    const installedPermissions = bootstrap.indexOf(
      '"$APP_DIR/deploy/scripts/set-application-permissions.sh"',
    );
    expect(installedPermissions).toBeGreaterThan(applicationSwap);
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
    expect(verifier).toContain('runuser -u "$SERVICE_USER" -- /usr/bin/test -x "$APP_DIR"');
    expect(verifier).toContain('runuser -u "$SERVICE_USER" -- /usr/bin/test -r "$UPDATER_SCRIPT"');
    expect(verifier).toContain('runuser -u "$SERVICE_USER" -- /usr/bin/test -w "$APP_DIR"');
    expect(verifier).toContain('! -user root');
    expect(verifier).toContain('! -group root');
    expect(verifier).toContain('-perm /022');
    expect(verifier).toContain('-writable -print -quit');
    expect(verifier).toContain('CONFIG_MODE="$(stat -c');
    expect(verifier).toContain('ENV_MODE="$(stat -c');
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
