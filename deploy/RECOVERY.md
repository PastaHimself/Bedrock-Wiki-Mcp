# Ubuntu failed-deployment recovery

Use this path when a previous Ubuntu bootstrap stopped after installing part of the application and the operator checkout is now dirty or contains an accidental nested clone.

The normal `bootstrap-ubuntu.sh` intentionally rejects a dirty source checkout. Do not bypass that guard with `git reset --hard`, `git clean`, or a permissive environment flag when local files may matter.

Instead, `deploy/scripts/recover-ubuntu.sh` resolves an exact committed Git revision, creates a separate clean detached worktree under `/tmp`, runs the unchanged production bootstrap from that clean worktree, and removes the temporary worktree afterward. It never resets, cleans, stashes, or rewrites the operator checkout.

## Typical recovery

First update the remote refs:

```bash
git fetch origin
```

Then recover using the currently fetched production branch:

```bash
sudo bash deploy/scripts/recover-ubuntu.sh origin/main
```

To recover to an exact validated commit instead, pass the full SHA:

```bash
sudo bash deploy/scripts/recover-ubuntu.sh <FULL_COMMIT_SHA>
```

Existing `/etc/bedrock-mcp/bedrock-mcp.env` contents are preserved by the normal bootstrap, so an existing bearer token does not need to be regenerated or printed.

## After recovery

Verify the service and index:

```bash
systemctl status bedrock-mcp.service --no-pager -l
curl --fail --silent --show-error http://127.0.0.1:8080/health
sudo -u bedrock-mcp env \
  BEDROCK_MCP_DATA_DIR=/var/lib/bedrock-mcp \
  BEDROCK_MCP_SEMANTIC_ENABLED=false \
  /usr/bin/node /opt/bedrock-wiki-mcp/dist/index.js status --json
```

If the knowledge updater fails, inspect:

```bash
systemctl status bedrock-mcp-update.service --no-pager -l
journalctl -u bedrock-mcp-update.service -n 200 --no-pager
```
