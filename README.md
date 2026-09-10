# Bedrock Wiki MCP

A self-hosted, read-only Model Context Protocol (MCP) server for Minecraft Bedrock Edition add-on development. It indexes official Creator documentation, samples, schemas, Script API package metadata, and selected community sources, then exposes deterministic evidence retrieval over Streamable HTTP.

> Beta: the project is under active development.

Public MCP endpoint: <https://bedrockmcpwiki.servegame.net/mcp>

## Quick start

Requirements: Node.js 24.x, npm, and Git on `PATH`.

```bash
npm ci
npm run check
npm run dev -- sync-sources
npm run dev -- rebuild-sources
npm run dev -- validate-index
npm run dev -- serve
```

After the initial full build, normal refreshes can update only changed source content:

```bash
npm run dev -- sync-sources
npm run dev -- update-sources
npm run dev -- validate-index
```

Local endpoints:

```text
http://127.0.0.1:8080/mcp
http://127.0.0.1:8080/health
```

For a lexical-only install that skips optional semantic-search packages, use `npm ci --omit=optional` and `npm run build`. See [`deploy/README.md`](deploy/README.md) for Ubuntu, Caddy, Cloudflare Tunnel, and Pterodactyl deployment guidance.

## Design

The server retrieves indexed source material and returns evidence. It does not generate answers and does not expose filesystem, shell, synchronization, database-write, backup, or administration operations through MCP.

Core capabilities include:

- Node.js 24.x, TypeScript, and the official MCP TypeScript SDK v2
- Streamable HTTP at `/mcp` and a minimal `/health` endpoint
- SQLite and FTS5 lexical retrieval
- exact Bedrock identifier lookup
- Markdown, Script API, JSON/JSONC, JavaScript, TypeScript, and mcfunction ingestion
- code-aware and schema-aware chunking
- stable, preview, historical, API-version, and Minecraft-version metadata
- source trust tiers and provenance
- deterministic query planning
- derived Script API runtime aliases such as `world.afterEvents.playerSpawn`
- deterministic symbol relationships such as `alias_of` and `property_type`
- exact cross-version definition comparison
- example-oriented retrieval
- conservative duplicate suppression
- optional local semantic search with Transformers.js and sqlite-vec
- atomic full and incremental index publication
- semantic embedding reuse for unchanged chunks
- index validation, backups, status reporting, and retrieval benchmarks

## Public MCP tools

| Tool | Purpose |
| --- | --- |
| `search` | Search indexed material with exact, lexical, and optional semantic retrieval |
| `fetch` | Fetch a server-issued document or chunk with bounded context |
| `get_definition` | Look up an exact identifier with stable-first, version-aware ranking |
| `find_examples` | Find code/example evidence for an identifier or development task |
| `compare_versions` | Compare one exact identifier between two API or Minecraft versions |
| `resolve_relationships` | Traverse deterministic symbol relationships in the Bedrock graph |
| `list_sources` | List source provenance, trust tier, release channel, health, and indexing details |
| `list_categories` | List Bedrock development categories in the index |
| `plan_lookup` | Classify a query and recommend the next retrieval tool |

All public tools are read-only, deterministic retrieval/inspection operations. They do not generate prose answers or mutate the index.

## Retrieval behavior

Generated Script API documentation often describes runtime chains across multiple type files. During indexing the server derives exact aliases and graph relationships so runtime-style requests can resolve to canonical documentation symbols:

```text
world.afterEvents.playerSpawn
world.afterEvents.playerSpawn.subscribe
system.runInterval
```

Identifier extraction also understands module-qualified imports such as `@minecraft/server.Player`, namespaced Bedrock identifiers, Molang queries such as `query.is_on_ground`, slash commands, manifest/schema fields, and animation-controller state names.

Stable Microsoft/Mojang evidence is preferred over preview, historical, or community material. Preview and historical content is excluded from normal retrieval unless explicitly requested or clearly implied. Optional `minecraftVersion` and `apiVersion` constraints prefer exact provenance, allow compatible numeric prefixes, reject known mismatches, and retain unversioned material only as lower-ranked fallback evidence.

Cross-source duplicate suppression is deliberately conservative. It removes essentially equivalent evidence after ranking while preserving differences between release channels, API versions, Minecraft versions, and conflicting identifiers.

### Example retrieval

`find_examples` first attempts symbol-linked examples for an extracted exact identifier, then fills remaining results from ranked `example` and `code` evidence. It supports module, API-version, Minecraft-version, preview, and historical filters.

### Version comparison

`compare_versions` compares the best indexed definition for one exact identifier at two explicit versions.

Example input shape:

```json
{
  "identifier": "World.getDynamicProperty",
  "versionKind": "api",
  "fromVersion": "1.9.0",
  "toVersion": "2.0.0"
}
```

The result reports `added`, `removed`, `changed`, `unchanged`, or `not_found`, returns the evidence snapshots for each side when available, and separately flags content, stability, lifecycle, and symbol-kind changes. It does not infer undocumented semantic behavior changes.

### Relationship graph

`resolve_relationships` traverses deterministic relationships stored in the index. Current post-index derivation materializes runtime alias and Script API property-type relationships. Traversal is bounded by depth and result count and returns source provenance where the edge has a source chunk.

This graph is intentionally evidence-derived rather than model-generated.

## Optional semantic search

Semantic retrieval is disabled by default. When enabled, the server retains exact/FTS5 candidates and fuses them with local cosine vector search. Exact Bedrock identifiers keep hard precedence over semantic similarity.

Optional packages:

```bash
npm ci
```

Lexical-only deployment:

```bash
npm ci --omit=optional
```

The semantic index is stored at:

```text
data/index/semantic.db
```

The default embedding model is `onnx-community/all-MiniLM-L6-v2-ONNX` at 384 dimensions. Model files are cached under `data/models/`.

Build or refresh semantic vectors after `bedrock.db` exists:

```bash
npm run dev -- build-semantic-index
```

Then enable hybrid retrieval:

```text
BEDROCK_MCP_SEMANTIC_ENABLED=true
```

Semantic publication remains atomic. If a compatible previous semantic database exists, vectors are reused for chunks whose stable chunk ID and content hash are unchanged. Only new or changed chunks are embedded. A different model, dimension, or semantic schema disables reuse and performs a fresh vector build.

`semantic.db` stores a fingerprint of the exact core index it was built against. Serving rejects stale, wrong-model, wrong-dimension, or wrong-schema semantic databases. If optional semantic initialization fails, serving falls back to lexical retrieval rather than taking the MCP offline.

## Knowledge sources

`config/sources.json` is the canonical registry for Git-backed knowledge sources. `config/npm-sources.json` is the canonical registry for bounded official npm metadata snapshots.

The registries define source identity, trust tier, release channel, branch, enablement, sparse checkout, and include/exclude rules. Keeping the registries canonical avoids maintaining a duplicate source list in this README as the corpus evolves.

The corpus includes:

- Microsoft/Mojang Creator documentation, samples, Script API material, schemas, debugger/tooling material, and preview-specific sources
- official `@minecraft/*` npm package metadata
- selected Bedrock Wiki, examples, schemas, editor/toolchain, modeling/animation, Script API, Molang, and interoperability community sources

Stable/default sources are selected normally. Preview-only sources require `--include-preview` or `BEDROCK_MCP_INCLUDE_PREVIEW=true`.

Source trust tier, release channel, repository, branch, revision, canonical URL, revision URL, hashes, and indexing timestamps are preserved as provenance where available.

## Source synchronization and indexing

Initial or explicit full rebuild:

```bash
npm run dev -- sync-sources
npm run dev -- rebuild-sources
npm run dev -- validate-index
```

Normal incremental refresh:

```bash
npm run dev -- sync-sources
npm run dev -- update-sources
npm run dev -- validate-index
```

Include preview material:

```bash
npm run dev -- sync-sources --include-preview
npm run dev -- update-sources --include-preview
```

`rebuild-sources` constructs a fresh SQLite database and atomically publishes it only after validation succeeds.

`update-sources` copies the currently published immutable index to a staging database, then:

1. compares each selected source revision and normalized indexing configuration;
2. skips sources whose upstream revision and indexing inputs are unchanged;
3. reparses only a changed source and replaces only added/modified documents;
4. removes documents that disappeared or were excluded by new source configuration;
5. refreshes unchanged-document provenance without rewriting their chunks;
6. re-derives affected runtime aliases/relationships when source inputs changed;
7. validates the staging database; and
8. atomically replaces the published index.

The full rebuild remains the recovery/fallback path.

Synchronization is fail-closed. Existing checkouts must have the configured origin and branch, a resolvable revision, and a clean worktree. Updates are fast-forward-only. Dirty, locally-ahead, divergent, detached, wrong-origin, wrong-branch, symlinked, or otherwise invalid checkouts are rejected rather than reset.

New clones use blobless single-branch partial clones. `sparsePaths` is opt-in for sources where the registry identifies a useful subtree.

Local curated Tier-3 knowledge can still be indexed separately:

```bash
npm run dev -- rebuild-index
# or
npm run dev -- rebuild-index /path/to/knowledge
```

## Administrative quality and operations

Inspect the published index:

```bash
npm run dev -- status
npm run dev -- status --json
```

Create an online-consistent backup:

```bash
npm run dev -- backup
npm run dev -- backup /srv/bedrock-backups --retain=14
```

Run stable retrieval benchmarks:

```bash
npm run dev -- benchmark
npm run dev -- benchmark --json
```

Run preview/beta benchmarks against a preview-enabled index:

```bash
npm run dev -- benchmark benchmarks/search-queries-preview.json
npm run dev -- benchmark benchmarks/search-queries-preview.json --json
```

Benchmarks report MRR, Recall@3, Recall@5, NDCG@5, exact Top-1, natural Top-3, useful Top-5, and required rank gates. The command exits nonzero when aggregate targets or a required case fails.

## Production deployment

See [`deploy/README.md`](deploy/README.md) for the full production guide.

The production updater:

1. obtains an exclusive refresh lock;
2. checks disk headroom;
3. backs up the currently published indexes;
4. synchronizes configured sources;
5. runs the atomic incremental lexical update;
6. validates the published lexical index;
7. updates the semantic index when enabled, reusing unchanged embeddings; and
8. lets the systemd unit restart the serving process so it reopens the newly published SQLite files.

The recommended Ubuntu service keeps Node on `127.0.0.1` and exposes only HTTPS through the selected ingress layer. Database and administrative ports are not required.

## Remote HTTP security

The application adds host-level controls around the MCP transport:

- optional exact Host allowlist
- optional exact Origin allowlist
- optional bearer-token authentication
- per-client rate limiting
- concurrent `/mcp` request cap
- bounded request bodies
- HTTP request/header timeouts
- `X-Content-Type-Options: nosniff`

`/health` remains unauthenticated and exposes only basic service status, name, and version.

For public deployments, configure `BEDROCK_MCP_ALLOWED_HOSTS` and enable bearer authentication when supported by the client. See [`.env.example`](.env.example) and [`deploy/systemd/bedrock-mcp.env.example`](deploy/systemd/bedrock-mcp.env.example).

## CLI

```text
bedrock-mcp serve
bedrock-mcp sync-sources [checkout-root] [--include-preview]
bedrock-mcp rebuild-index [directory]
bedrock-mcp rebuild-sources [checkout-root] [--include-preview]
bedrock-mcp update-sources [checkout-root] [--include-preview]
bedrock-mcp build-semantic-index
bedrock-mcp status [--json]
bedrock-mcp backup [destination] [--retain=N]
bedrock-mcp benchmark [file] [--json]
bedrock-mcp validate-index
bedrock-mcp version
bedrock-mcp help
```

Synchronization, indexing, status, backup, and benchmark commands are administrative process operations, not public MCP tools.

## Repository data policy

Generated deployment state is ignored by Git, including lexical/semantic SQLite files, WAL/SHM files, cached semantic models, cloned source checkouts, temporary ingestion files, backups, and logs.

`knowledge/local/` is reserved for deliberately curated local material.

## License

The code and documentation in this repository are licensed under the [Apache License, Version 2.0](LICENSE).

Third-party sources indexed by the server retain their own licenses and attribution requirements.
