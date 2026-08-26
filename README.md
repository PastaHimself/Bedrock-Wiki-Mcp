# Bedrock Wiki MCP

A self-hosted, read-only Model Context Protocol knowledge server for Minecraft Bedrock Edition add-on development.

## Status

Milestones 0–3 are implemented. Milestone 4 (remote HTTP hardening) is in progress on its feature branch.

The current server provides:

- Node.js 24 LTS + TypeScript
- official Model Context Protocol TypeScript SDK v2
- Streamable HTTP at `/mcp`
- health endpoint at `/health`
- SQLite + FTS5 persistence and lexical retrieval
- Bedrock-aware Markdown, Script API, JSON, JavaScript, and TypeScript ingestion
- exact identifier lookup plus natural-language FTS search
- stable/preview/historical metadata and ranking
- controlled `doc_*` / `chk_*` fetching; no arbitrary filesystem reads
- no paid API, embedding API, or hosted vector database required

Official-source synchronization is **not implemented yet**. Source definitions are already modeled, but automated cloning/updating of Microsoft/Mojang repositories belongs to Milestone 5 and later.

## Public MCP tools

The v1 public surface intentionally stays small and read-only:

- `search` — search documentation, API definitions, JSON, and code using exact + lexical retrieval
- `fetch` — fetch server-issued document/chunk IDs with bounded adjacent context
- `get_definition` — look up an exact Bedrock identifier with stable-first version handling
- `list_sources` — inspect indexed source provenance and trust tiers
- `list_categories` — inspect categories currently present in the index

The server does not expose arbitrary file reads, shell commands, database writes, or source-update operations as MCP tools.

## Design constraints

- Public MCP functionality is read-only.
- Stable Microsoft/Mojang documentation takes priority over preview, historical, or community material.
- Preview and historical material are distinguishable in metadata and excluded from normal retrieval unless explicitly requested or clearly implied by the query.
- Generated databases and source checkouts are deployment state and are not committed to Git.
- Retrieval responses are bounded by result and character limits.

## Configured official knowledge sources

`config/sources.json` currently describes the intended official ingestion targets:

1. `MicrosoftDocs/minecraft-creator` — Creator documentation and Script API reference.
2. `Mojang/bedrock-samples` `main` — official stable behavior/resource pack samples.
3. `Mojang/bedrock-samples` `preview` — preview samples, kept distinct from stable material.
4. `microsoft/minecraft-samples` — official tutorial and project samples.

Automated source synchronization will be implemented in Milestone 5/7. Until then, `rebuild-index` indexes local knowledge from `knowledge/local/` or a directory supplied on the command line.

## Development

Requirements:

- Node.js 24.x
- npm

Install reproducibly:

```bash
npm ci
```

Run checks:

```bash
npm run check
```

Rebuild the local index:

```bash
npm run dev -- rebuild-index
# or
npm run dev -- rebuild-index /path/to/knowledge
```

Validate the SQLite/FTS index:

```bash
npm run dev -- validate-index
```

Start the development server:

```bash
npm run dev -- serve
```

The safe default bind is local-only:

```text
http://127.0.0.1:8080/mcp
```

Health check:

```text
GET http://127.0.0.1:8080/health
```

## Remote HTTP security

The MCP SDK handles the modern 2026 per-request HTTP protocol and retains a stateless legacy fallback for 2025-era clients. The application adds the security controls that the SDK deliberately leaves to the host application:

- optional exact Host allowlist
- optional exact Origin allowlist
- optional bearer-token authentication
- per-client fixed-window rate limiting
- concurrent `/mcp` request cap
- MCP request-body size limit
- HTTP header/request timeouts
- `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`

`/health` intentionally remains unauthenticated and exposes only service status/name/version.

For local development, Host/Origin allowlists and bearer authentication are disabled unless configured. For a public deployment, set `BEDROCK_MCP_ALLOWED_HOSTS` to the public MCP hostname and enable authentication if the client supports it. See [`.env.example`](.env.example) for all settings.

TLS should terminate at a reverse proxy or tunnel; the Node process should normally remain on a private/local bind and should not expose SQLite or administrative ports.

## Current CLI

```text
bedrock-mcp serve
bedrock-mcp rebuild-index [directory]
bedrock-mcp validate-index
bedrock-mcp version
bedrock-mcp help
```

Index/source update commands are administrative process operations and are not public MCP tools.

## Repository data policy

The following are generated locally/deployed and ignored by Git:

- SQLite indexes
- SQLite WAL/SHM files
- cloned upstream knowledge sources
- temporary ingestion files
- backups
- logs

`knowledge/local/` is reserved for deliberately curated local source material.

## License

A project license has not been selected yet.
