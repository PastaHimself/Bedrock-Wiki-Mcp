# 2 vCPU / 2 GB / 20 GB VPS profile

This profile is the recommended baseline for the small IPv6-only production VPS. It keeps the public MCP process on loopback, uses Cloudflare Tunnel for public ingress, and stays lexical-only until RAM and disk headroom have been measured in production.

## Recommended environment

Start from `deploy/systemd/bedrock-mcp.env.example` and keep these values unless measurements justify changing them:

```text
BEDROCK_MCP_HOST=127.0.0.1
BEDROCK_MCP_PORT=8080
BEDROCK_MCP_MAX_CONCURRENT_REQUESTS=8
BEDROCK_MCP_SEMANTIC_ENABLED=false
BEDROCK_MCP_INCLUDE_PREVIEW=false
BEDROCK_MCP_BACKUP_RETAIN=3
BEDROCK_MCP_MIN_FREE_BYTES=2147483648
```

The application-level concurrency default remains higher for larger deployments; the systemd example deliberately overrides it for two CPU cores. Semantic packages can be omitted entirely with `npm ci --omit=optional` on this profile.

## Disk budget

Disk is the tightest resource. Source synchronization uses `git clone --filter=blob:none --single-branch --no-tags` for new checkouts. Blobless partial clones keep the complete checked-out branch contents needed by ingestion while avoiding historical blob downloads until Git actually needs them.

Sparse checkout is intentionally not enabled. Two configured stable sources are ingested without include-path restrictions, and narrowing those worktrees would risk silently losing future Bedrock files. If sparse checkout is evaluated later, do it per source with explicit coverage tests rather than globally.

The updater keeps a fixed free-space reserve and adds operation-specific headroom before it starts disk-heavy work. With the default profile it requires at least 2 GiB free plus the larger of:

- the current lexical + semantic database size for the next online backup, or
- 1.5 times the current lexical database size for an atomic replacement build.

It checks again after the backup and after source synchronization. A low-disk failure occurs before publishing a replacement index or restarting the public service.

Backup storage grows roughly with `retention × snapshot size`. With semantic disabled and little local curated knowledge, snapshot size is dominated by `bedrock.db`. Three retained updater snapshots are therefore a safer starting point than seven on a 20 GB disk; the standalone backup command still defaults to seven.

Measure the real deployment instead of relying on repository-size estimates:

```bash
node dist/index.js status --json
du -sh /var/lib/bedrock-mcp/sources
du -sh /var/lib/bedrock-mcp/index
du -sh /var/lib/bedrock-mcp/backups
du -sh /var/lib/bedrock-mcp/models 2>/dev/null || true
df -h /var/lib/bedrock-mcp
```

`status --json` reports the exact published `bedrock.db` byte size. Keep enough additional free space for one replacement database even when scheduled backups already consume their normal steady-state allocation.

## RAM and semantic search

Lexical serving should not load Transformers.js model weights or sqlite-vec. Semantic dependencies are loaded only when the semantic path is actually used, and this deployment keeps `BEDROCK_MCP_SEMANTIC_ENABLED=false`.

Do not enable semantic retrieval on this host until lexical serving and updater peak RSS have been observed. Enabling it adds the model cache, `semantic.db`, ONNX runtime memory, and embedding-build CPU/RAM pressure to the same 2 GB machine.

## Public ingress

Preferred topology:

```text
Public MCP clients
       |
   Cloudflare
       |
Cloudflare Tunnel
       |
127.0.0.1:8080
       |
  Bedrock MCP
```

Use `deploy/cloudflare/config.yml.example`. Keep port 8080 off the public firewall, keep `BEDROCK_MCP_ALLOWED_HOSTS` set to the public hostname, and expose no database, updater, backup, shell, or other administrative endpoint.

## Operational checks

After each deploy or resource-tuning change:

```bash
systemctl status bedrock-mcp.service
systemctl status bedrock-mcp-update.service
curl --fail --silent http://127.0.0.1:8080/health
node dist/index.js status --json
df -h /var/lib/bedrock-mcp
```

If the disk guard rejects an update, free space or reduce retained backups before retrying. Do not lower the reserve simply to force a rebuild through a nearly full filesystem.
