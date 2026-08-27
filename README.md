# Bedrock Wiki MCP

A self-hosted, read-only Model Context Protocol knowledge server for Minecraft Bedrock Edition add-on development.

## Status

Milestones 0–7 are merged. Milestone 8 adds production deployment templates for Ubuntu/systemd, HTTPS ingress, scheduled source/index refreshes, IPv6-only VPS deployments, and Pterodactyl.

The server currently provides:

- Node.js 24 LTS + TypeScript
- official Model Context Protocol TypeScript SDK v2
- Streamable HTTP at `/mcp`
- health endpoint at `/health`
- SQLite + FTS5 persistence and lexical retrieval
- Bedrock-aware Markdown, Script API, JSON, JavaScript, and TypeScript ingestion
- exact identifier lookup plus natural-language FTS search
- derived Script API aliases such as `world.afterEvents.playerSpawn`
- stable/preview/historical metadata and ranking
- Minecraft/API version-compatible filtering and ranking
- controlled `doc_*` / `chk_*` fetching; no arbitrary filesystem reads
- verified Microsoft/Mojang Git source ingestion
- safe administrative source clone/fetch/fast-forward synchronization
- no paid API, embedding API, or hosted vector database required for normal operation

## Public MCP tools

The v1 public surface intentionally stays small and read-only:

- `search` — exact + lexical search across docs, Script API, JSON, and code
- `fetch` — fetch server-issued document/chunk IDs with bounded context
- `get_definition` — exact identifier lookup with stable-first, version-aware handling
- `list_sources` — indexed source provenance and trust tiers
- `list_categories` — categories currently present in the index

The public MCP server does **not** expose arbitrary file reads, shell commands, database writes, source synchronization, or index-update operations.

## Retrieval behavior

Generated Script API documentation often describes a runtime chain across multiple type files. During index rebuilds the server derives those relationships and materializes exact aliases, so runtime-style queries resolve to canonical documentation symbols:

```text
world.afterEvents.playerSpawn
world.afterEvents.playerSpawn.subscribe
system.runInterval
```

Stable Microsoft/Mojang material has priority over preview, historical, or community material. Preview/historical content is excluded from normal retrieval unless explicitly requested or clearly implied by the query.

Optional `minecraftVersion` and `apiVersion` constraints prefer exact provenance, allow compatible numeric prefixes, reject known mismatches, and retain unversioned material only as lower-ranked fallback evidence.

## Official sources

`config/sources.json` defines the official ingestion targets:

1. `MicrosoftDocs/minecraft-creator` — Creator docs, commands, references, current Script API, and prior Script API.
2. `Mojang/bedrock-samples` `main` — stable behavior/resource pack samples.
3. `Mojang/bedrock-samples` `preview` — preview samples, disabled by default.
4. `microsoft/minecraft-samples` — official tutorials and projects.

Source trust tier, release channel, repository, branch, revision, canonical URL, revision URL, and hashes are preserved as provenance where available.

## Development

Requirements:

- Node.js 24.x
- npm
- Git on `PATH` for `sync-sources`

Install and validate:

```bash
npm ci
npm run check
```

Run the development server:

```bash
npm run dev -- serve
```

Default local endpoints:

```text
http://127.0.0.1:8080/mcp
http://127.0.0.1:8080/health
```

## Source synchronization and indexing

Stable/default-enabled upstream sources:

```bash
npm run dev -- sync-sources
npm run dev -- rebuild-sources
npm run dev -- validate-index
```

Include preview sources explicitly:

```bash
npm run dev -- sync-sources --include-preview
npm run dev -- rebuild-sources --include-preview
```

A custom checkout root can be supplied as the positional argument to both source commands.

Synchronization is fail-closed: existing checkouts must have the configured origin and branch, a resolvable revision, and a clean worktree. Updates are fast-forward-only. Dirty, locally-ahead, divergent, detached, wrong-origin, wrong-branch, symlinked, or otherwise invalid checkouts are rejected rather than reset.

`rebuild-sources` builds a separate SQLite database and only replaces the published index after validation succeeds.

Local curated Tier-3 knowledge can be indexed separately:

```bash
npm run dev -- rebuild-index
# or
npm run dev -- rebuild-index /path/to/knowledge
```

## Production deployment

See [`deploy/README.md`](deploy/README.md) for the full production guide.

Included templates cover:

- hardened Ubuntu `systemd` service
- scheduled `sync-sources -> rebuild-sources -> validate-index` refreshes
- post-refresh service restart so the process reopens the new SQLite inode
- Caddy HTTPS reverse proxy
- public IPv6/`AAAA` deployment
- Cloudflare Tunnel for outbound-only ingress
- production environment layout
- backup/recovery considerations
- Pterodactyl startup, persistence, and scheduled updates

The recommended Ubuntu service keeps Node on `127.0.0.1` and exposes only HTTPS through the selected ingress layer. Database and administrative ports are never required.

## Remote HTTP security

The application adds host-level controls around the MCP SDK transport:

- optional exact Host allowlist
- optional exact Origin allowlist
- optional bearer-token authentication
- per-client rate limiting
- concurrent `/mcp` request cap
- bounded MCP request bodies
- HTTP request/header timeouts
- `X-Content-Type-Options: nosniff`

`/health` intentionally remains unauthenticated and exposes only basic service status/name/version.

For public deployments, set `BEDROCK_MCP_ALLOWED_HOSTS` to the public MCP hostname and enable bearer authentication when the client supports it. See [`.env.example`](.env.example) and [`deploy/systemd/bedrock-mcp.env.example`](deploy/systemd/bedrock-mcp.env.example).

## CLI

```text
bedrock-mcp serve
bedrock-mcp sync-sources [checkout-root] [--include-preview]
bedrock-mcp rebuild-index [directory]
bedrock-mcp rebuild-sources [checkout-root] [--include-preview]
bedrock-mcp validate-index
bedrock-mcp version
bedrock-mcp help
```

Synchronization and indexing commands are administrative process operations, not public MCP tools.

## Repository data policy

Generated deployment state is ignored by Git:

- SQLite indexes and WAL/SHM files
- cloned upstream knowledge sources
- temporary ingestion files
- backups
- logs

`knowledge/local/` is reserved for deliberately curated local material.

## License

A project license has not been selected yet.
