# Bedrock Wiki MCP

A self-hosted, read-only Model Context Protocol knowledge server for Minecraft Bedrock Edition add-on development.

## Status

Milestones 0–6 are merged. Milestone 7 (safe administrative upstream source synchronization) is implemented on a feature branch pending final validation/merge.

The current server provides:

- Node.js 24 LTS + TypeScript
- official Model Context Protocol TypeScript SDK v2
- Streamable HTTP at `/mcp`
- health endpoint at `/health`
- SQLite + FTS5 persistence and lexical retrieval
- Bedrock-aware Markdown, Script API, JSON, JavaScript, and TypeScript ingestion
- exact identifier lookup plus natural-language FTS search
- derived Script API runtime aliases such as `world.afterEvents.playerSpawn`
- stable/preview/historical metadata and ranking
- Minecraft/API version-compatible filtering and ranking
- controlled `doc_*` / `chk_*` fetching; no arbitrary filesystem reads
- official Microsoft/Mojang source ingestion from verified local Git checkouts
- explicit administrative source clone/fetch/fast-forward synchronization
- no paid API, embedding API, or hosted vector database required

Network synchronization remains an administrative process operation. Normal MCP serving is read-only and public MCP tools cannot clone, fetch, update, rebuild, or otherwise mutate source/index state.

## Public MCP tools

The v1 public surface intentionally stays small and read-only:

- `search` — search documentation, API definitions, JSON, and code using exact + lexical retrieval; optional `minecraftVersion` and `apiVersion` constraints prefer exact provenance, allow compatible numeric prefixes, and retain unversioned material only as fallback evidence
- `fetch` — fetch server-issued document/chunk IDs with bounded adjacent context
- `get_definition` — look up an exact Bedrock identifier with stable-first, version-aware handling
- `list_sources` — inspect indexed source provenance and trust tiers
- `list_categories` — inspect categories currently present in the index

The server does not expose arbitrary file reads, shell commands, database writes, source synchronization, or index-update operations as MCP tools.

## Bedrock identifier aliases

Generated Script API documentation often describes a runtime chain across multiple type files. For example, `World.afterEvents` has type `WorldAfterEvents`, while `playerSpawn` is documented on `WorldAfterEvents`.

During index rebuilds the server derives those relationships and materializes exact aliases, so these runtime-style queries resolve to canonical documentation symbols:

```text
world.afterEvents.playerSpawn
world.afterEvents.playerSpawn.subscribe
system.runInterval
```

Alias derivation is based on documented property signatures and canonical members, not a hand-maintained identifier list. Derived chains are depth-bounded and globally capped during a rebuild. Search and definition responses still return the canonical documented identifier rather than presenting a generated alias as the source symbol.

## Design constraints

- Public MCP functionality is read-only.
- Stable Microsoft/Mojang documentation takes priority over preview, historical, or community material.
- Preview and historical material are distinguishable in metadata and excluded from normal retrieval unless explicitly requested or clearly implied by the query.
- Known version mismatches are excluded when a version constraint is supplied; exact matches outrank compatible prefixes, and evidence without version provenance remains a lower-ranked fallback.
- Generated databases and source checkouts are deployment state and are not committed to Git.
- Retrieval responses are bounded by result and character limits.
- Official-source index rebuilds are performed into a temporary SQLite database and replace the live index only after validation succeeds.
- Existing source checkouts are never reset or force-updated by synchronization; dirty, locally-ahead, or divergent checkouts fail closed.

## Configured official knowledge sources

`config/sources.json` describes the official ingestion targets:

1. `MicrosoftDocs/minecraft-creator` — Creator documents, command reference, general reference, current Script API, and prior Script API material.
2. `Mojang/bedrock-samples` `main` — official stable behavior/resource pack samples.
3. `Mojang/bedrock-samples` `preview` — preview samples, disabled by default and kept distinct from stable material.
4. `microsoft/minecraft-samples` — official tutorial and project samples.

The source trust tier and release channel are preserved in the SQLite index and exposed through retrieval metadata.

## Development

Requirements:

- Node.js 24.x
- npm
- Git available on `PATH` for `sync-sources`

Install reproducibly:

```bash
npm ci
```

Run checks:

```bash
npm run check
```

### Local curated knowledge

Rebuild the local Tier-3 curated index:

```bash
npm run dev -- rebuild-index
# or
npm run dev -- rebuild-index /path/to/knowledge
```

### Official source synchronization

By default, configured source checkouts live under:

```text
data/sources/ms_creator_docs/
data/sources/bedrock_samples_stable/
data/sources/bedrock_samples_preview/
data/sources/minecraft_samples/
```

Synchronize the stable/default-enabled sources:

```bash
npm run dev -- sync-sources
```

Use a different checkout root:

```bash
npm run dev -- sync-sources /srv/bedrock-sources
```

Include preview sources explicitly:

```bash
npm run dev -- sync-sources --include-preview
```

Missing sources are cloned into a temporary sibling directory, validated for configured origin/branch/revision, then renamed into place. Existing sources must already pass the same trust checks and have a clean worktree. Synchronization fetches the configured branch and updates only when the local commit is an ancestor of the fetched remote commit; locally-ahead, diverged, detached, wrong-origin, wrong-branch, dirty, symlinked, or otherwise invalid checkouts are rejected instead of being reset.

Git commands run without an interactive credential prompt and with bounded execution time/output. The configured branch syntax is validated before it can be used as a Git argument.

### Official source indexing

After synchronization, rebuild the official-source index from the same checkout root:

```bash
npm run dev -- rebuild-sources
```

Or, for a custom checkout root:

```bash
npm run dev -- rebuild-sources /srv/bedrock-sources
```

Preview sources are also excluded from indexing by default. Include them explicitly when building a preview-aware index:

```bash
npm run dev -- rebuild-sources --include-preview
```

The rebuild streams documents instead of holding the whole corpus in RAM. Files outside the configured include/exclude rules, unsupported extensions, symlinks, and oversized files are skipped. Repository revision, branch, canonical file URL, revision-pinned URL, source file hash, and source modification time are preserved as provenance when available. Script API aliases are derived after all selected sources are indexed so cross-file type/member relationships are available.

A typical administrative refresh is therefore:

```bash
npm run dev -- sync-sources
npm run dev -- rebuild-sources
npm run dev -- validate-index
```

Validate the SQLite/FTS index independently:

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
- MCP request-body size limit, enforced before MCP dispatch
- HTTP header/request timeouts
- `X-Content-Type-Options: nosniff`
- application-generated JSON responses use `Cache-Control: no-store`; successful MCP responses use the pinned SDK's `Cache-Control: no-cache, no-transform`

`/health` intentionally remains unauthenticated and exposes only service status/name/version.

For local development, Host/Origin allowlists and bearer authentication are disabled unless configured. For a public deployment, set `BEDROCK_MCP_ALLOWED_HOSTS` to the public MCP hostname and enable authentication if the client supports it. See [`.env.example`](.env.example) for all settings.

TLS should terminate at a reverse proxy or tunnel; the Node process should normally remain on a private/local bind and should not expose SQLite or administrative ports.

## Current CLI

```text
bedrock-mcp serve
bedrock-mcp sync-sources [checkout-root] [--include-preview]
bedrock-mcp rebuild-index [directory]
bedrock-mcp rebuild-sources [checkout-root] [--include-preview]
bedrock-mcp validate-index
bedrock-mcp version
bedrock-mcp help
```

Synchronization and index/source update commands are administrative process operations and are not public MCP tools.

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
