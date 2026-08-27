# 2 vCPU / 2 GB / 20 GB VPS profile

This is the production runbook for the small IPv6-only VPS. The MCP process stays on loopback, Cloudflare Tunnel provides public ingress, SQLite/FTS5 remains the primary retrieval path, and semantic retrieval stays disabled until production measurements justify enabling it.

## Target topology

```text
Public MCP clients
       |
   Cloudflare
       |
Cloudflare Tunnel (cloudflared)
       |
127.0.0.1:8080
       |
  Bedrock MCP
```

Do not expose Node port 8080, SQLite, updater commands, backups, or any shell/admin endpoint publicly.

## Fresh Ubuntu deployment

Clone the repository as the normal administrative user and explicitly select the revision that passed CI:

```bash
sudo apt-get update
sudo apt-get install -y git
git clone https://github.com/PastaHimself/Bedrock-Wiki-Mcp.git
cd Bedrock-Wiki-Mcp
git checkout <validated-commit-sha-or-tag>
git status --short
```

`git status --short` must be empty. The bootstrap refuses a dirty source checkout and archives the exact Git `HEAD` being deployed.

For the first installation, provide the public hostname. Add a bearer token when the intended MCP client supports it:

```bash
sudo \
  BEDROCK_MCP_PUBLIC_HOSTNAME=bedrock-mcp.example.com \
  BEDROCK_MCP_BEARER_TOKEN='replace-with-a-long-random-secret' \
  bash deploy/scripts/bootstrap-ubuntu.sh
```

If the client cannot send bearer authentication, omit `BEDROCK_MCP_BEARER_TOKEN`. When supplied through the bootstrap, the token must be at least 16 characters and use token-safe characters suitable for the unquoted systemd environment-file format.

The bootstrap intentionally uses the fixed paths referenced by the hardened systemd units:

```text
/opt/bedrock-wiki-mcp
/etc/bedrock-mcp/bedrock-mcp.env
/var/lib/bedrock-mcp
```

It performs these operations:

1. verifies Ubuntu and installs the small base package set;
2. installs Node.js 24 from the NodeSource signed APT repository when `/usr/bin/node` is not already Node 24;
3. creates the unprivileged `bedrock-mcp` service account and persistent directories;
4. runs Git inspection/archive operations as the checkout owner rather than weakening Git `safe.directory` protection for root;
5. stages the exact clean Git `HEAD` under `/opt`;
6. runs reproducible `npm ci`, builds `dist/`, then prunes development and semantic optional dependencies and smoke-tests the built lexical-only runtime;
7. creates `/etc/bedrock-mcp/bedrock-mcp.env` only on the first install; later runs preserve the existing production environment and secrets;
8. before an upgrade reuses an existing `bedrock.db` only when the staged new application can open it read-only with the exact serving schema and `status --json` reports successful integrity/FTS validation;
9. installs the hardened server/update systemd units and rebuilds the lexical index when it is missing or incompatible;
10. enables the server and daily update timer;
11. runs `deploy/scripts/verify-production.sh` before reporting success.

The full optional dependency set exists only during the source build. The installed runtime is pruned back to lexical production dependencies, and `BEDROCK_MCP_SEMANTIC_ENABLED=false` remains mandatory for this profile.

The initial knowledge build can take substantially longer than the application install because it synchronizes the configured Bedrock repositories and builds the SQLite/FTS5 index.

## Required small-VPS environment

Keep these values unless a deliberate production change has been measured and reviewed:

```text
BEDROCK_MCP_HOST=127.0.0.1
BEDROCK_MCP_PORT=8080
BEDROCK_MCP_DATA_DIR=/var/lib/bedrock-mcp
BEDROCK_MCP_TRUSTED_PROXY_IPS=127.0.0.1
BEDROCK_MCP_MAX_CONCURRENT_REQUESTS=8
BEDROCK_MCP_SEMANTIC_ENABLED=false
BEDROCK_MCP_INCLUDE_PREVIEW=false
BEDROCK_MCP_BACKUP_RETAIN=3
BEDROCK_MCP_MIN_FREE_BYTES=2147483648
```

`BEDROCK_MCP_TRUSTED_PROXY_IPS=127.0.0.1` is specific to the direct `cloudflared -> http://127.0.0.1:8080` topology. It allows the MCP server to use Cloudflare's validated `CF-Connecting-IP` as the per-client rate-limit key. Do not copy that setting into an unrelated local proxy topology that might forward attacker-supplied `CF-Connecting-IP` unchanged.

## Cloudflare Tunnel

Use `deploy/cloudflare/README.md` for the exact current stable APT installation and locally managed Tunnel procedure. The essential account-dependent steps are:

```bash
cloudflared tunnel login
cloudflared tunnel create bedrock-mcp
cloudflared tunnel list
```

Install the generated tunnel credentials and `deploy/cloudflare/config.yml.example` under `/etc/cloudflared`. The application ingress must remain:

```yaml
tunnel: <TUNNEL-UUID>
credentials-file: /etc/cloudflared/<TUNNEL-UUID>.json

ingress:
  - hostname: bedrock-mcp.example.com
    service: http://127.0.0.1:8080
    originRequest:
      connectTimeout: 10s
      noHappyEyeballs: false
  - service: http_status:404
```

Validate the ingress configuration:

```bash
sudo cloudflared tunnel ingress validate
sudo cloudflared tunnel ingress rule https://bedrock-mcp.example.com/mcp
```

Create the DNS route as the same normal user that ran `cloudflared tunnel login`, then install the system service:

```bash
cloudflared tunnel route dns bedrock-mcp bedrock-mcp.example.com
sudo cloudflared --config /etc/cloudflared/config.yml service install
sudo systemctl enable --now cloudflared.service
sudo systemctl status cloudflared.service --no-pager
```

The repository cannot perform `tunnel login`, choose your Cloudflare zone, or authorize DNS on your behalf; those steps require your Cloudflare account. The application itself still requires no inbound HTTP/HTTPS listener on the VPS because `cloudflared` establishes the outbound Tunnel.

## Final production verification

After the Tunnel is active, run:

```bash
sudo \
  BEDROCK_MCP_REQUIRE_CLOUDFLARED=true \
  BEDROCK_MCP_PUBLIC_URL=https://bedrock-mcp.example.com \
  /opt/bedrock-wiki-mcp/deploy/scripts/verify-production.sh
```

The verifier is intentionally strict. It checks:

- `/usr/bin/node` is Node.js major version 24;
- the production environment uses `/var/lib/bedrock-mcp`, loopback binding, direct Tunnel proxy trust, and semantic disabled;
- the server service and update timer are active and enabled;
- the actual TCP listener is only `127.0.0.1:<port>`;
- localhost `/health` succeeds;
- the published lexical database reports `ok=true` and an exact `indexBytes` value;
- a real local MCP `initialize` exchange succeeds using the configured allowed `Host` and bearer token when present;
- free disk remains above the configured reserve;
- when requested, `cloudflared.service` is active and enabled;
- `BEDROCK_MCP_PUBLIC_URL` is exactly `https://` plus the configured public hostname;
- public `/health` succeeds through Cloudflare;
- a real MCP `initialize` exchange succeeds through the public Tunnel.

The verifier reads only the required `KEY=value` entries from the root-owned environment file; it does not execute the file as shell code.

Also inspect timers and recent logs:

```bash
systemctl list-timers bedrock-mcp-update.timer
journalctl -u bedrock-mcp.service -n 100 --no-pager
journalctl -u bedrock-mcp-update.service -n 100 --no-pager
journalctl -u cloudflared.service -n 100 --no-pager
```

Treat a verifier failure as an incomplete deployment. Fix the reported condition rather than weakening the check.

## Disk budget

Disk is the tightest resource. New source checkouts always use blobless, single-branch, no-tag clones:

```text
git clone --filter=blob:none --single-branch --no-tags
```

Whole-repository sources such as the stable Bedrock Samples checkout keep their normal worktree so future Bedrock files are not silently omitted. Sparse checkout is opt-in per source through validated `sparsePaths` in `config/sources.json`. It is used for repositories where the knowledge-bearing subtree is explicit and materially reduces disk usage—for example, only `docs/` from the large `Bedrock-OSS/bedrock-wiki` repository and targeted schema/protocol/tooling directories. Sparse paths are repository-relative directories, are validated before being passed to Git, and are re-applied during source updates.

The updater keeps a fixed free-space reserve and operation-specific headroom. With the default profile it requires at least 2 GiB free plus the larger of the estimated online-backup requirement or 1.5 times the current lexical database size for an atomic replacement build. It checks again after backup and source synchronization.

Three retained updater snapshots are the low-disk starting point. With semantic disabled, backup size is normally dominated by `bedrock.db`.

Measure the real deployment:

```bash
sudo -u bedrock-mcp env BEDROCK_MCP_DATA_DIR=/var/lib/bedrock-mcp \
  /usr/bin/node /opt/bedrock-wiki-mcp/dist/index.js status --json
du -sh /var/lib/bedrock-mcp/sources
du -sh /var/lib/bedrock-mcp/index
du -sh /var/lib/bedrock-mcp/backups
du -sh /var/lib/bedrock-mcp/models 2>/dev/null || true
df -h /var/lib/bedrock-mcp
```

Keep enough additional free space for one replacement database even after normal retained backups are accounted for.

## RAM and semantic search

Do not enable semantic retrieval on this 2 GB host until lexical serving and updater peak RSS, CPU duration, and disk consumption have been observed. Enabling semantic retrieval adds model cache, `semantic.db`, ONNX runtime memory, and embedding-build pressure to the same machine.

## Application upgrades

Deploy only an exact revision that has passed CI:

```bash
git fetch --tags origin
git checkout <new-validated-commit-sha-or-tag>
git status --short
sudo bash deploy/scripts/bootstrap-ubuntu.sh
```

The bootstrap preserves the existing production environment. Before stopping the current service it asks the staged new build to run `status --json` against the current index in read-only serving mode. If the schema or integrity is incompatible, the bootstrap schedules a normal atomic source/index rebuild instead of mutating the existing index in place.

After every application upgrade, rerun the full public verifier.
