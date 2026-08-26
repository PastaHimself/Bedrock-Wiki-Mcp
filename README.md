# Bedrock Wiki MCP

A self-hosted, read-only Model Context Protocol server for Minecraft Bedrock Edition add-on development knowledge.

## Status

**Milestone 0 — repository/bootstrap is in progress.** Search, indexing, and document ingestion are intentionally not implemented yet.

The planned v1 stack is:

- Node.js 24 LTS
- TypeScript
- official Model Context Protocol TypeScript SDK v2
- Streamable HTTP at `/mcp`
- SQLite + FTS5 lexical retrieval
- Bedrock-aware parsing, chunking, exact identifier matching, and version-aware ranking
- no paid API or hosted vector database required for normal operation

## Design constraints

- Public MCP functionality is read-only.
- The MCP server will expose knowledge, not arbitrary filesystem access or command execution.
- Stable Microsoft/Mojang documentation takes priority over preview, historical, or community material.
- Preview and historical API material will be distinguishable in metadata and excluded from default retrieval when a current stable answer exists.
- Generated databases and source checkouts are deployment state and are not committed to Git.

## Planned knowledge sources

1. `MicrosoftDocs/minecraft-creator` — primary Creator documentation and Script API reference.
2. `Mojang/bedrock-samples` `main` — official stable behavior/resource pack samples.
3. `Mojang/bedrock-samples` `preview` — optional preview material, disabled by default.
4. `microsoft/minecraft-samples` — official tutorial and project samples.

Source definitions live in [`config/sources.json`](config/sources.json).

## Development

Requirements:

- Node.js 24.x
- npm

Install dependencies:

```bash
npm install
```

Run checks:

```bash
npm run check
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

Environment variables are documented in [`.env.example`](.env.example).

## Current CLI

```text
bedrock-mcp serve
bedrock-mcp version
bedrock-mcp help
```

Administrative ingestion/index commands will be added in later milestones and will not be exposed as public MCP tools.

## Repository data policy

The following are generated locally/deployed and ignored by Git:

- SQLite indexes
- SQLite WAL/SHM files
- cloned upstream knowledge sources
- temporary ingestion files
- backups
- logs

`knowledge/local/` is reserved for curated local source material added deliberately to the repository later.

## License

A project license has not been selected yet.
