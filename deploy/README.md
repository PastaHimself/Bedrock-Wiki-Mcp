# Production deployment

This directory contains deployment templates for the production milestone. The public MCP server remains read-only; source synchronization and index replacement are explicit administrative operations. Optional semantic retrieval is disabled by default; the local Qwen answer helper is enabled by default and requires an installed `llama-server` executable.

## Recommended Ubuntu layout

```text
/opt/bedrock-wiki-mcp/          application checkout/build (root-owned)
/etc/bedrock-mcp/               production environment configuration (root-owned)
/var/lib/bedrock-mcp/           persistent indexes, model cache, source checkouts, update lock
```

Recommended service identity:

```bash
sudo useradd --system \
  --home-dir /var/lib/bedrock-mcp \
  --create-home \
  --shell /usr/sbin/nologin \
  bedrock-mcp
sudo install -d -o bedrock-mcp -g bedrock-mcp -m 0750 /var/lib/bedrock-mcp
sudo install -d -o root -g bedrock-mcp -m 0750 /etc/bedrock-mcp
```

Install Node.js 24, npm, Git, `flock`/`runuser` (normally supplied by `util-linux` on Ubuntu), and your selected HTTPS ingress. The supplied systemd templates assume Node is `/usr/bin/node`; change the unit if your Node installation lives elsewhere.

Clone/copy the repository to `/opt/bedrock-wiki-mcp`. For a semantic-enabled host, install the full reproducible dependency set and build it:

```bash
cd /opt/bedrock-wiki-mcp
sudo npm ci
sudo npm run check
sudo npm run build
```

For a lexical-only low-resource host, omit the Transformers.js/sqlite-vec runtime during the build as well as in production:

```bash
sudo npm ci --omit=optional
sudo npm run build
sudo npm prune --omit=dev --omit=optional
```

Do not enable `BEDROCK_MCP_SEMANTIC_ENABLED` on an installation that omitted optional dependencies. The application directory should not be writable by `bedrock-mcp`; deployment code and persistent knowledge state are deliberately separated.

## Production environment

Copy the template and edit it as root:

```bash
sudo install -m 0640 -o root -g bedrock-mcp \
  deploy/systemd/bedrock-mcp.env.example \
  /etc/bedrock-mcp/bedrock-mcp.env
sudo editor /etc/bedrock-mcp/bedrock-mcp.env
```

At minimum, set:

- `NODE_ENV=production`
- `BEDROCK_MCP_DATA_DIR=/var/lib/bedrock-mcp`
- `BEDROCK_MCP_ALLOWED_HOSTS` to the exact public hostname
- `BEDROCK_MCP_BEARER_TOKEN` when the target MCP client supports bearer authentication

Semantic retrieval is optional:

```text
BEDROCK_MCP_SEMANTIC_ENABLED=false
BEDROCK_MCP_SEMANTIC_MODEL=onnx-community/all-MiniLM-L6-v2-ONNX
BEDROCK_MCP_SEMANTIC_TOP_K=40
```

Leave it disabled on the smallest hosts. When enabled, the updater builds `/var/lib/bedrock-mcp/index/semantic.db` and caches the model under `/var/lib/bedrock-mcp/models/`. The public service loads the model from that persistent cache with remote model loading disabled.

The Node service should normally bind only to `127.0.0.1:8080`. Do not expose SQLite, source-update commands, or an administrative port.

### Optional local Qwen answer helper

The helper runs Qwen locally through llama-server. It is not a cloud API integration. With the default settings, the Node service starts llama-server on a private loopback port and its `-hf` option downloads the model into the persistent cache on first startup. Install a current llama.cpp build with llama-server first, and verify the executable is available:

~~~bash
llama-server --version
~~~

Before starting the bedrock-mcp.service unit, set these values in `/etc/bedrock-mcp/bedrock-mcp.env`:

~~~text
BEDROCK_MCP_LOCAL_LLM_ENABLED=true
BEDROCK_MCP_LOCAL_LLM_BASE_URL=http://127.0.0.1:8081/v1
BEDROCK_MCP_LOCAL_LLM_BINARY=/usr/local/bin/llama-server
BEDROCK_MCP_LOCAL_LLM_MODEL=Qwen/Qwen3-1.7B-GGUF:Q8_0
BEDROCK_MCP_LOCAL_LLM_THREADS=2
BEDROCK_MCP_LOCAL_LLM_STARTUP_TIMEOUT_MS=900000
BEDROCK_MCP_LOCAL_LLM_TIMEOUT_MS=60000
BEDROCK_MCP_LOCAL_LLM_MAX_TOKENS=512
BEDROCK_MCP_LOCAL_LLM_RETRIEVAL_LIMIT=6
~~~

The Node service creates `/var/lib/bedrock-mcp/models/huggingface`, starts llama-server, waits for `/health`, and stops the child process on shutdown. If the runtime is missing or the first model load fails, the Node service remains online and reports the local-runtime error only when `ask_bedrock` is called. The repository also includes an optional separate systemd unit for operators who want Qwen supervised independently; use that unit instead of Node auto-start when installing it. It assumes the llama-server binary is `/usr/local/bin/llama-server`; edit `deploy/systemd/bedrock-qwen.service` if your build is elsewhere:

~~~bash
sudo install -d -o bedrock-mcp -g bedrock-mcp -m 0750 /var/lib/bedrock-mcp/models/huggingface
sudo install -m 0644 deploy/systemd/bedrock-qwen.service /etc/systemd/system/bedrock-qwen.service
sudo systemctl daemon-reload
sudo systemctl enable --now bedrock-qwen.service
~~~

To make the Node service wait for Qwen readiness, add this optional drop-in with `sudo systemctl edit bedrock-mcp.service`:

~~~ini
[Unit]
Requires=bedrock-qwen.service
After=bedrock-qwen.service
~~~

The Q8 model is about 1.83 GB on disk; on a 3 GiB VPS, use `--ctx-size 4096`, `--threads 2`, `--threads-batch 2`, and `--parallel 1`, measure peak RSS, and switch to a smaller Qwen3 quantization or Qwen3 0.6B if the processes do not fit together. Set `BEDROCK_MCP_LOCAL_LLM_THREADS=1` in `/etc/bedrock-mcp/bedrock-mcp.env` when the host imposes stricter thread limits; both the Node-managed and separately supervised helpers read that value. The MCP server remains usable with the helper disabled. If using the separate unit, check it with `systemctl status bedrock-qwen.service` and `journalctl -u bedrock-qwen.service -n 200 --no-pager`.

## systemd

Install the units:

```bash
sudo install -m 0644 deploy/systemd/bedrock-mcp.service /etc/systemd/system/bedrock-mcp.service
sudo install -m 0644 deploy/systemd/bedrock-mcp-update.service /etc/systemd/system/bedrock-mcp-update.service
sudo install -m 0644 deploy/systemd/bedrock-mcp-update.timer /etc/systemd/system/bedrock-mcp-update.timer
sudo systemctl daemon-reload
```

Perform the first source synchronization/index build before starting the public service:

```bash
sudo systemctl start bedrock-mcp-update.service
sudo systemctl status bedrock-mcp-update.service
```

If semantic retrieval is enabled, that first updater run also downloads/caches the configured embedding model and builds the matching semantic index before the server is started.

Then enable the server and scheduled refresh:

```bash
sudo systemctl enable --now bedrock-mcp.service
sudo systemctl enable --now bedrock-mcp-update.timer
```

Useful diagnostics:

```bash
systemctl status bedrock-mcp.service
systemctl status bedrock-mcp-update.timer
systemctl list-timers bedrock-mcp-update.timer
journalctl -u bedrock-mcp.service -n 200 --no-pager
journalctl -u bedrock-mcp-update.service -n 200 --no-pager
curl --fail --silent http://127.0.0.1:8080/health
```

The timer runs once per day with randomized delay. Change `OnCalendar=` in the timer if a different cadence is required. The update service allows up to two hours because full semantic embedding can be much slower than lexical indexing on 1–2 vCPU hosts.

### Why the updater restarts the server

`rebuild-sources` creates and validates a separate SQLite database, closes it, then atomically renames it over the published lexical index. This protects the live index from partial rebuilds. A process that already has the old SQLite file open continues using that old inode, so the update unit restarts `bedrock-mcp.service` only after synchronization, lexical rebuild/validation, and (when enabled) semantic rebuilding all succeed.

The semantic database records a fingerprint of the exact lexical chunks it was built from. A source refresh therefore intentionally makes the old semantic database stale. The updater rebuilds `semantic.db` before restart; the server also rejects a stale semantic fingerprint at startup as a second consistency guard.

A failed refresh leaves the currently running service untouched. Atomic lexical/semantic build paths prevent partially written replacement databases from being published.

## HTTPS option A: public IPv6 + Caddy

For an IPv6-only VPS with direct inbound connectivity:

1. Create an `AAAA` record for `bedrock-mcp.example.com` pointing to the VPS IPv6 address.
2. Allow inbound TCP 80/443 in the host/provider firewall.
3. Keep Node bound to `127.0.0.1:8080`.
4. Install Caddy and copy `deploy/caddy/Caddyfile.example` to your Caddy configuration.
5. Replace the example hostname and reload Caddy.

Example checks:

```bash
curl -6 --fail https://bedrock-mcp.example.com/health
curl --fail https://bedrock-mcp.example.com/health
```

The second command also tests whether the hostname is reachable to IPv4-only clients. A DNS-only `AAAA` origin cannot serve IPv4-only clients directly; use a dual-stack reverse proxy/CDN or Cloudflare Tunnel when that matters.

## HTTPS option B: Cloudflare Tunnel

Cloudflare Tunnel is appropriate when the VPS has no convenient public ingress, is IPv6-only but clients may be IPv4-only, or you do not want inbound HTTP/HTTPS firewall rules.

The application still binds to `127.0.0.1:8080`; `cloudflared` establishes the outbound connection and publishes the hostname.

Use `deploy/cloudflare/config.yml.example` as the local ingress template after creating the tunnel and credentials. Keep the final catch-all `http_status:404` rule.

With Tunnel, do not expose port 8080 publicly. `BEDROCK_MCP_ALLOWED_HOSTS` should still be the public MCP hostname.

## Reverse-proxy behavior

The MCP transport can return JSON or long-lived streaming HTTP responses. Do not configure a proxy to buffer streaming responses aggressively, and do not add a short global request timeout to `/mcp`. The supplied Caddy configuration uses normal streaming reverse-proxy behavior and leaves the MCP endpoint path unchanged:

```text
https://bedrock-mcp.example.com/mcp
```

Health remains:

```text
https://bedrock-mcp.example.com/health
```

## Backups

The authoritative knowledge sources are upstream Git repositories and the indexes are reproducibly generated, so the SQLite databases do not need to be treated as irreplaceable data. Still, production deployments should back up at least:

- `/etc/bedrock-mcp/bedrock-mcp.env` using a secret-capable backup system
- any deliberately curated local knowledge not recoverable from Git
- optionally `/var/lib/bedrock-mcp/index/bedrock.db` and `semantic.db` to reduce recovery time
- optionally `/var/lib/bedrock-mcp/models/` to avoid re-downloading semantic model files during recovery

Do not publish backups containing bearer tokens or other deployment secrets.

## Pterodactyl deployment

Pterodactyl does not provide systemd or sudo inside the server container. Use persistent `/home/container` storage and keep every mutable path beneath it.

Recommended environment:

```text
NODE_ENV=production
BEDROCK_MCP_HOST=0.0.0.0
BEDROCK_MCP_PORT=<allocated panel port>
BEDROCK_MCP_DATA_DIR=/home/container/data
BEDROCK_MCP_ALLOWED_HOSTS=<public hostname>
BEDROCK_MCP_SEMANTIC_ENABLED=false
BEDROCK_MCP_LOCAL_LLM_ENABLED=true
BEDROCK_MCP_LOCAL_LLM_BINARY=llama-server
BEDROCK_MCP_LOCAL_LLM_MODEL=Qwen/Qwen3-1.7B-GGUF:Q8_0
BEDROCK_MCP_LOCAL_LLM_THREADS=2
```

Install/build during initial setup or an install script. Use normal `npm ci` when semantic retrieval is enabled:

```bash
npm ci
npm run build
```

For a lexical-only build and runtime, optional semantic packages may be omitted entirely:

```bash
npm ci --omit=optional
npm run build
npm prune --omit=dev --omit=optional
```

Panel startup command:

```bash
node dist/index.js serve
```

To use the local helper in a Pterodactyl container, keep the llama-server binary and the `data/models/huggingface` cache on persistent storage. Node automatically starts llama-server and downloads the model on first startup when `BEDROCK_MCP_LOCAL_LLM_ENABLED=true`. Set `BEDROCK_MCP_LOCAL_LLM_BINARY` to the installed binary path if it is not on `PATH`; do not expose port 8081 as a public allocation.

Initial knowledge setup from the Pterodactyl console:

```bash
node dist/index.js sync-sources
node dist/index.js rebuild-sources
node dist/index.js validate-index
```

If semantic retrieval is enabled, build it after the lexical index:

```bash
node dist/index.js build-semantic-index
```

For periodic updates, use a Pterodactyl scheduled task to run the same source sync/rebuild/validation sequence. When semantic mode is enabled, run `build-semantic-index` after lexical validation and before the panel restart. The restart is required for the running process to open the newly published SQLite databases.

Do not run `npm ci` on every normal server restart unless the panel installation model requires it; dependencies, `dist/`, and the model cache should already exist on persistent storage.

TLS normally terminates outside the Pterodactyl container (panel/reverse proxy/CDN). Expose only the panel-allocated application port to that proxy.

## Deployment verification checklist

Before considering a deployment healthy:

```text
[ ] Node.js major version is 24
[ ] full/semantic install: npm ci succeeds
[ ] lexical-only install: npm ci --omit=optional builds and starts without semantic packages
[ ] production dependency audit / typecheck / tests / build pass on deployed revision
[ ] sync-sources succeeds
[ ] rebuild-sources succeeds
[ ] validate-index reports ok=true
[ ] if semantic enabled: optional semantic dependencies are installed
[ ] if semantic enabled: build-semantic-index succeeds and model cache is persistent
[ ] if semantic enabled: server starts with remote model loading disabled
[ ] Node binds only to intended host/port
[ ] /health returns 200 through localhost and public HTTPS
[ ] /mcp is reachable through HTTPS
[ ] public hostname is present in BEDROCK_MCP_ALLOWED_HOSTS
[ ] bearer authentication is configured when supported by the client
[ ] update timer/scheduled task is enabled
[ ] failed updates do not replace the current indexes
[ ] successful updates restart the serving process
[ ] no database/admin port is publicly exposed
```
