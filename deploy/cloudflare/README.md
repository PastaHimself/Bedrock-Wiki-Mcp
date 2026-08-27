# Cloudflare Tunnel production setup

This directory contains the locally managed Cloudflare Tunnel configuration used by the small Ubuntu VPS profile. Node remains bound to `127.0.0.1:8080`; only `cloudflared` connects to it.

## Install cloudflared from Cloudflare's stable APT repository

Cloudflare's current recommended generic Debian-based repository works for Ubuntu without hard-coding a release codename:

```bash
sudo mkdir -p --mode=0755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
  | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null

echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' \
  | sudo tee /etc/apt/sources.list.d/cloudflared.list

sudo apt-get update
sudo apt-get install -y cloudflared
cloudflared --version
```

Use the stable repository above, not the nightly repository, for production.

## Create a locally managed tunnel

Run authentication and tunnel creation as the normal administrative user, not through `sudo`, so the Cloudflare account certificate is stored in that user's `~/.cloudflared/` directory:

```bash
cloudflared tunnel login
cloudflared tunnel create bedrock-mcp
cloudflared tunnel list
```

Record the UUID printed by `tunnel create`. The same command creates `~/.cloudflared/<TUNNEL-UUID>.json`.

## Install the production configuration

```bash
sudo install -d -o root -g root -m 0750 /etc/cloudflared
sudo install -o root -g root -m 0600 \
  "$HOME/.cloudflared/<TUNNEL-UUID>.json" \
  "/etc/cloudflared/<TUNNEL-UUID>.json"

sudo install -o root -g root -m 0644 \
  deploy/cloudflare/config.yml.example \
  /etc/cloudflared/config.yml
sudo editor /etc/cloudflared/config.yml
```

Replace the UUID, credentials path, and public hostname. The application origin must remain:

```yaml
service: http://127.0.0.1:8080
```

The final ingress rule must remain:

```yaml
- service: http_status:404
```

Validate and test the locally installed configuration:

```bash
sudo cloudflared tunnel ingress validate
sudo cloudflared tunnel ingress rule https://bedrock-mcp.example.com/mcp
```

## Create DNS and install the service

Create the DNS route as the same normal user that ran `cloudflared tunnel login`; `route dns` needs the account certificate in that user's `~/.cloudflared/` directory:

```bash
cloudflared tunnel route dns bedrock-mcp bedrock-mcp.example.com
```

Then install the root system service using the explicit production config path:

```bash
sudo cloudflared --config /etc/cloudflared/config.yml service install
sudo systemctl enable --now cloudflared.service
sudo systemctl status cloudflared.service --no-pager
```

Do not expose TCP 8080, SQLite, updater commands, backups, or shell/admin services through this Tunnel.

## Verify through public HTTPS

Once DNS and the Tunnel are active:

```bash
curl --fail --silent --show-error https://bedrock-mcp.example.com/health

sudo \
  BEDROCK_MCP_REQUIRE_CLOUDFLARED=true \
  BEDROCK_MCP_PUBLIC_URL=https://bedrock-mcp.example.com \
  /opt/bedrock-wiki-mcp/deploy/scripts/verify-production.sh
```

`BEDROCK_MCP_PUBLIC_URL` must be the exact `https://` URL for the first hostname in `BEDROCK_MCP_ALLOWED_HOSTS`; the verifier does not accept an unrelated endpoint as evidence that the deployment is healthy.

The verifier checks `cloudflared.service`, public `/health`, a real public MCP `initialize` exchange through the Tunnel, the loopback-only Node listener, the published lexical index and its integrity, the local MCP exchange, Node 24, and the configured disk reserve.
