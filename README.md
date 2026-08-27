# Bedrock Wiki MCP

A self-hosted, read-only Model Context Protocol knowledge server for Minecraft Bedrock Edition add-on development.

## Status

Milestones 0–9 are merged. The original implementation roadmap is complete, including the optional local semantic-search upgrade. The repository also includes administrative quality/operations tooling for status reporting, online backups, and repeatable retrieval benchmarks.

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
- optional local Transformers.js + sqlite-vec semantic retrieval
- controlled `doc_*` / `chk_*` fetching; no arbitrary filesystem reads
- verified Microsoft/Mojang Git source ingestion plus lower-ranked community knowledge
- safe administrative source clone/fetch/fast-forward synchronization
- online SQLite backups with retention
- measurable retrieval quality benchmarks
- no paid API, embedding API, or hosted vector database required

## Public MCP tools

The public surface intentionally stays small and read-only:

- `search` — exact + lexical search, optionally fused with local semantic retrieval
- `fetch` — fetch server-issued document/chunk IDs with bounded context
- `get_definition` — exact identifier lookup with stable-first, version-aware handling
- `list_sources` — indexed source provenance and trust tiers
- `list_categories` — categories currently present in the index

The public MCP server does **not** expose arbitrary file reads, shell commands, database writes, source synchronization, backup, benchmark, status administration, or index-update operations.

## Retrieval behavior

Generated Script API documentation often describes a runtime chain across multiple type files. During index rebuilds the server derives those relationships and materializes exact aliases, so runtime-style queries resolve to canonical documentation symbols:

```text
world.afterEvents.playerSpawn
world.afterEvents.playerSpawn.subscribe
system.runInterval
```

Stable Microsoft/Mojang material has priority over preview, historical, or community material. Preview/historical content is excluded from normal retrieval unless explicitly requested or clearly implied by the query. The semantic path follows the same release-channel intent rules as lexical search.

Optional `minecraftVersion` and `apiVersion` constraints prefer exact provenance, allow compatible numeric prefixes, reject known mismatches, and retain unversioned material only as lower-ranked fallback evidence.

### Optional semantic search

Semantic retrieval is disabled by default. When enabled, the server keeps the existing exact/FTS5 candidate path and fuses it with a local cosine vector search using weighted reciprocal-rank fusion. Exact Bedrock identifiers always retain hard precedence over semantic similarity.

The semantic runtime packages (`@huggingface/transformers` and `sqlite-vec`) are npm optional dependencies and are loaded lazily. A lexical-only deployment can omit them entirely:

```bash
npm ci --omit=optional
```

A semantic-enabled deployment must install the optional packages with the normal reproducible install:

```bash
npm ci
```

The semantic index is isolated at:

```text
data/index/semantic.db
```

The default embedding model is `onnx-community/all-MiniLM-L6-v2-ONNX` at 384 dimensions. Model files are cached beneath `data/models/`. The administrative build command may download/cache the model; the serving process disables remote model loading and reads only the existing cache.

Build the semantic index after `bedrock.db` exists:

```bash
npm run dev -- build-semantic-index
```

Then enable hybrid retrieval:

```text
BEDROCK_MCP_SEMANTIC_ENABLED=true
```

`semantic.db` stores a fingerprint of the exact lexical/core index it was built from. The server refuses stale, wrong-model, wrong-dimension, or wrong-schema semantic databases instead of silently combining inconsistent indexes.

Low-RAM deployments should leave semantic retrieval disabled and may use `npm ci --omit=optional`. The five public MCP tools and lexical behavior remain available without loading or installing the embedding model/vector runtime.

## Knowledge sources

`config/sources.json` defines the upstream ingestion targets and their trust/release boundaries.

Stable/default-enabled sources:

1. `MicrosoftDocs/minecraft-creator` — Tier 1 Creator docs, commands, references, current Script API, and prior Script API.
2. `Mojang/bedrock-samples` `main` — Tier 2 stable behavior/resource pack samples.
3. `microsoft/minecraft-samples` — Tier 2 official tutorials and projects.
4. `Mojang/minecraft-scripting-libraries` — Tier 2 official reusable scripting libraries and examples.
5. `Mojang/minecraft-debugger` — Tier 2 Bedrock scripting/BDS debugger and diagnostics documentation.
6. `Mojang/minecraft-creator-tools` — Tier 3 targeted Creator Tools documentation.
7. `Bedrock-OSS/bedrock-wiki` `wiki` — Tier 3 community documentation. Sparse checkout selects its `docs/` knowledge subtree (Git cone mode may retain repository-root files), and only Markdown knowledge is indexed, so community material cannot outrank higher-tier official material on equal lifecycle/channel evidence.

Preview-only sources are selected only with `--include-preview` / `BEDROCK_MCP_INCLUDE_PREVIEW=true`:

- `Mojang/bedrock-samples` `preview`.
- `Mojang/bedrock-schemas` `main` — machine-readable Behavior Pack/Resource Pack JSON Schemas. The upstream head is currently preview-oriented, so it is not treated as stable.
- `Mojang/bedrock-protocol-docs` `main` — current packet/type/enum metadata and protocol guides. The current Git head is preview-oriented; versioned GitHub Release assets are not silently treated as the stable worktree.
- `microsoft/minecraft-scripting-samples` — Beta Script API examples.
- `microsoft/minecraft-gametests` — Beta GameTest examples.
- `Mojang/minecraft-editor`, `Mojang/minecraft-editor-extension-samples`, and `Mojang/minecraft-editor-extension-starter-kit` — Editor/extension material, which is Preview-specific upstream.

JSON Schema ingestion creates individual definition chunks for schema properties such as `minecraft:collision_box`. Protocol-style JSON Schemas also expose packet/type names and scoped properties as exact identifiers and preserve `x-minecraft-version` metadata for version-aware retrieval.

Source trust tier, release channel, repository, branch, revision, canonical URL, revision URL, and hashes are preserved as provenance where available.

## Development

Requirements:

- Node.js 24.x
- npm
- Git on `PATH` for `sync-sources`

Install and validate with semantic dependencies available:

```bash
npm ci
npm run check
```

For a lexical-only runtime install, use:

```bash
npm ci --omit=optional
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

New clones use blobless single-branch partial clones. Whole-repository sources keep their normal worktree. `sparsePaths` is opt-in per source and is used only where the registry explicitly identifies a safe documentation/schema subtree, such as `Bedrock-OSS/bedrock-wiki` `docs/`; it is not applied globally to Bedrock Samples.

`rebuild-sources` builds a separate SQLite database and only replaces the published index after validation succeeds. If semantic retrieval is enabled, rebuild `semantic.db` after publishing a new lexical index; the production updater does this automatically.

Local curated Tier-3 knowledge can be indexed separately:

```bash
npm run dev -- rebuild-index
# or
npm run dev -- rebuild-index /path/to/knowledge
```

## Administrative quality and operations

Inspect the published index without exposing an admin HTTP endpoint:

```bash
npm run dev -- status
npm run dev -- status --json
```

`status` reports schema/integrity state, database size, document/chunk/identifier counts, FTS consistency, and per-source revision/coverage.

Create an online-consistent backup using Node's SQLite backup API:

```bash
npm run dev -- backup
npm run dev -- backup /srv/bedrock-backups --retain=14
```

A snapshot contains `bedrock.db`, `semantic.db` when present, repository `config/`, curated `knowledge/local/`, and a manifest. Symlinks and non-regular files in copied project material are skipped. The default destination is `data/backups/` with seven retained snapshots. Production scheduled refreshes create this backup **before** source synchronization/rebuild.

Run the committed retrieval-quality suite against the currently published lexical index:

```bash
npm run dev -- benchmark
npm run dev -- benchmark --json
```

The default suite is `benchmarks/search-queries.json`. It covers core exact/runtime-chain and natural-language Bedrock queries and reports MRR, Recall@3, Recall@5, NDCG@5, exact Top-1, natural Top-3, and useful Top-5. The command exits nonzero when configured quality targets fail, so it can be used as a deployment/release gate after a real official-source index has been built.

## Production deployment

See [`deploy/README.md`](deploy/README.md) for the full production guide.

Included templates cover:

- hardened Ubuntu `systemd` service
- scheduled source/index refreshes
- pre-refresh online backups with retention
- optional semantic-index rebuild before service restart
- post-refresh service restart so the process reopens new SQLite inodes
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

Generated deployment state is ignored by Git:

- lexical and semantic SQLite indexes and WAL/SHM files
- cached local semantic model files
- cloned upstream knowledge sources
- temporary ingestion files
- backups
- logs

`knowledge/local/` is reserved for deliberately curated local material.

## License

A project license has not been selected yet.
