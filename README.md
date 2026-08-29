# Bedrock Wiki MCP

A self-hosted, read-only Model Context Protocol knowledge server for Minecraft Bedrock Edition add-on development.

FRE USE: https://bedrockmcpwiki.servegame.net/mcp


- this mcp server is still in beta


## Status

The MCP is built as a Bedrock development knowledge service rather than a generic document search server. It combines official Creator documentation, official samples/tools/schemas, official `@minecraft/*` npm package metadata, selected community material, exact identifier indexing, version/channel-aware retrieval, conservative deduplication, and optional local semantic search.

The server currently provides:

- Node.js 24 LTS + TypeScript
- official Model Context Protocol TypeScript SDK v2
- Streamable HTTP at `/mcp`
- health endpoint at `/health`
- SQLite + FTS5 persistence and lexical retrieval
- Bedrock-aware Markdown, Script API, JSON, JavaScript, and TypeScript ingestion
- code-aware TypeScript/JavaScript chunks for functions, classes, interfaces, enums, aliases, arrow functions, and event subscriptions
- exact identifier lookup for Script API symbols, Bedrock namespaced identifiers, Molang, commands, manifest/schema fields, and animation-controller states
- derived Script API aliases such as `world.afterEvents.playerSpawn`
- stable/preview/historical metadata and ranking
- authoritative read-only npm metadata snapshots for verified `@minecraft/*` Script API modules
- Minecraft/API version-compatible filtering and ranking
- intent-aware ranking for definitions, examples, manifests, package versions, debugging, stable, and preview questions
- conservative cross-source duplicate suppression that preserves distinct versions/channels
- optional local Transformers.js + sqlite-vec semantic retrieval with lexical fallback
- optional local Qwen3 answer helper grounded in indexed evidence, with resource citations
- controlled `doc_*` / `chk_*` fetching; no arbitrary filesystem reads
- section-aware fetch context and code/example evidence from `get_definition`
- verified Microsoft/Mojang Git source ingestion plus lower-ranked community knowledge
- safe administrative source clone/fetch/fast-forward synchronization
- source health, provenance, duplicate percentage, and indexing timestamps through `list_sources`
- online SQLite backups with retention
- stable and preview retrieval quality suites with per-question rank gates
- no paid API, embedding API, or hosted vector database required

## Public MCP tools

The public surface intentionally stays small and read-only:

- `search` — exact + lexical search, optionally fused with local semantic retrieval; supports optional source/category/channel/module/path/version filters
- `fetch` — fetch server-issued document/chunk IDs with bounded adjacent or heading-section context
- `get_definition` — exact identifier lookup with stable-first, version-aware handling plus relevant indexed code/examples
- `list_sources` — indexed source provenance, trust tiers, release channel, counts, health, duplicate percentage, revision, and last indexing time
- `list_categories` — controlled Bedrock development categories currently present in the index
- `ask_bedrock` — optional local Qwen answer generation over search evidence with `[R#]` citations; disabled unless explicitly enabled

The public MCP server does **not** expose arbitrary file reads, shell commands, database writes, source synchronization, backup, benchmark, status administration, or index-update operations.

## Retrieval behavior

Generated Script API documentation often describes a runtime chain across multiple type files. During index rebuilds the server derives those relationships and materializes exact aliases, so runtime-style queries resolve to canonical documentation symbols:

```text
world.afterEvents.playerSpawn
world.afterEvents.playerSpawn.subscribe
system.runInterval
```

Identifier extraction also understands module-qualified imports such as `@minecraft/server.Player`, namespaced Bedrock component identifiers, Molang queries such as `query.is_on_ground`, slash commands, `format_version` values, manifest fields, schema properties, and animation-controller state names.

Stable Microsoft/Mojang material has priority over preview, historical, or community material. Preview/historical content is excluded from normal retrieval unless explicitly requested or clearly implied by the query. Version/package questions receive additional preference for official npm metadata, while example/tutorial queries prefer real code and sample evidence. The semantic path follows the same release-channel and filter rules as lexical search.

Optional `minecraftVersion` and `apiVersion` constraints prefer exact provenance, allow compatible numeric prefixes, reject known mismatches, and retain unversioned material only as lower-ranked fallback evidence.

Cross-source near-duplicate suppression is deliberately conservative. It removes essentially equivalent search evidence after ranking so the higher-trust result survives, but it does not collapse material across different release channels, API versions, Minecraft versions, or conflicting identifiers.

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

`semantic.db` stores a fingerprint of the exact lexical/core index it was built from. The server refuses stale, wrong-model, wrong-dimension, or wrong-schema semantic databases instead of silently combining inconsistent indexes. If optional semantic initialization fails, serving degrades to the lexical SQLite/FTS5 path instead of taking the MCP offline.

For constrained servers, keep the model cache and `semantic.db` on persistent storage and use the default MiniLM-class model rather than a substantially larger embedding model. Semantic retrieval remains optional; the six public tools and exact/lexical behavior are fully available without it.

### Optional local Qwen helper

The answer helper is local-only. It searches the existing SQLite index, gives bounded excerpts to Qwen, and returns the answer together with the exact indexed resources used. It does not call a hosted AI API and does not replace the deterministic retrieval tools.

Install a current `llama.cpp` build that provides `llama-server`, then start the official Qwen3 1.7B GGUF on loopback:

~~~bash
llama-server \
  -hf Qwen/Qwen3-1.7B-GGUF:Q8_0 \
  --host 127.0.0.1 \
  --port 8081 \
  --ctx-size 4096 \
  --parallel 1
~~~

The official Q8 model is about 1.83 GB on disk. On a 3 GiB host, keep the context and concurrency conservative; CPU speed affects response time, while model weights and context consume RAM. If the combined Node/Qwen process exceeds available memory, use a smaller Qwen3 quantization or Qwen3 0.6B without changing the MCP integration.

Enable the helper in `.env`:

~~~text
BEDROCK_MCP_LOCAL_LLM_ENABLED=true
BEDROCK_MCP_LOCAL_LLM_BASE_URL=http://127.0.0.1:8081/v1
BEDROCK_MCP_LOCAL_LLM_MODEL=Qwen/Qwen3-1.7B-GGUF:Q8_0
BEDROCK_MCP_LOCAL_LLM_TIMEOUT_MS=60000
BEDROCK_MCP_LOCAL_LLM_MAX_TOKENS=512
BEDROCK_MCP_LOCAL_LLM_RETRIEVAL_LIMIT=6
~~~

Start `llama-server` before the MCP process. The helper uses `/no_think` for normal lookup questions, limits evidence to six resources/8,000 characters so it fits the 4K model context with generation space, and reports a clear error if the local endpoint is disabled or unavailable. Keep port 8081 private; only expose the MCP endpoint through your normal reverse proxy.

## Knowledge sources

`config/sources.json` defines the upstream Git ingestion targets and their trust/release boundaries. `config/npm-sources.json` separately defines bounded snapshots from the official npm registry for verified Minecraft Script API packages.

Stable/default-enabled Git sources:

1. `MicrosoftDocs/minecraft-creator` — Tier 1 Creator docs, commands, references, current Script API, and prior Script API.
2. `Mojang/bedrock-samples` `main` — Tier 2 stable behavior/resource pack samples.
3. `microsoft/minecraft-samples` — Tier 2 official tutorials and projects.
4. `Mojang/minecraft-scripting-libraries` — Tier 2 official reusable scripting libraries and examples.
5. `Mojang/minecraft-debugger` — Tier 2 Bedrock scripting/BDS debugger and diagnostics documentation.
6. `Mojang/minecraft-creator-tools` — Tier 3 targeted Creator Tools documentation.
7. `Bedrock-OSS/bedrock-wiki` `wiki` — Tier 3 community documentation. Sparse checkout selects its `docs/` knowledge subtree, and only Markdown knowledge is indexed.
8. `Bedrock-OSS/bedrock-examples` — Tier 3 maintained behavior/resource-pack example companion to Bedrock Wiki. Sparse checkout selects `resources/`, and include rules retain only JSON, JavaScript, TypeScript, mcfunction, and Markdown evidence rather than binary assets.
9. `bridge-core/docs` — Tier 3 bridge. editor guides and reference documentation.
10. `bridge-core/editor-packages` — Tier 3 bridge. schemas and Bedrock file definitions.
11. `Blockception/minecraft-bedrock-language-server` — Tier 3 language-server diagnostics, project helpers, and IDE tooling.
12. `Blockception/Minecraft-bedrock-json-schemas` — Tier 3 community behavior/resource-pack schemas.
13. `JaylyDev/ScriptAPI` `stable` — Tier 3 community Script API samples and packages.
14. `JannisX11/blockbench` — Tier 3 Blockbench Bedrock format implementation and type definitions.
15. `Nusiq/mcblend` — Tier 3 Bedrock modeling and animation documentation.
16. `bedrock-core/server` — Tier 3 addon interoperability framework documentation and packages.
17. `JannisX11/bedrock-json-schemas` — Tier 3 historical compatibility schemas.
18. `minecraft-addon-tools/minecraft-addon-toolchain` — Tier 3 historical addon build tooling.

Stable npm metadata is enabled by default for verified modules including `@minecraft/server`, `@minecraft/server-ui`, and `@minecraft/common`. It preserves exact npm versions/dist-tags and generates stable manifest dependency evidence where appropriate.

Preview-only sources are selected only with `--include-preview` / `BEDROCK_MCP_INCLUDE_PREVIEW=true`:

- `Mojang/bedrock-samples` `preview`.
- `Mojang/bedrock-schemas` `main` — machine-readable Behavior Pack/Resource Pack JSON Schemas. The upstream head is currently preview-oriented, so it is not treated as stable.
- `Mojang/bedrock-protocol-docs` `main` — current packet/type/enum metadata and protocol guides. The current Git head is preview-oriented.
- `microsoft/minecraft-scripting-samples` — Beta Script API examples.
- `microsoft/minecraft-gametests` — Beta GameTest examples.
- `Mojang/minecraft-editor`, `Mojang/minecraft-editor-extension-samples`, and `Mojang/minecraft-editor-extension-starter-kit` — Editor/extension material, which is Preview-specific upstream.
- official npm beta/RC metadata for verified modules such as `@minecraft/server`, `@minecraft/server-ui`, `@minecraft/server-editor`, `@minecraft/server-gametest`, and other configured `@minecraft/*` packages.

Preview npm versions are stored as exact package/type-definition evidence. The MCP does not assume that a full npm Preview build suffix is automatically a valid `manifest.json` dependency version; manifest guidance must be supported by matching official documentation/sample evidence.

JSON Schema ingestion creates individual definition chunks for schema properties such as `minecraft:collision_box`. Protocol-style JSON Schemas also expose packet/type names and scoped properties as exact identifiers and preserve `x-minecraft-version` metadata for version-aware retrieval.

Source trust tier, release channel, repository, branch, revision, canonical URL, revision URL, hashes, and indexing timestamps are preserved as provenance where available.

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
npm run build
```

This build path never installs the local embedding/vector stack. Run the built server with `node dist/index.js serve`.

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

Stable/default-enabled upstream sources and official stable npm metadata:

```bash
npm run dev -- sync-sources
npm run dev -- rebuild-sources
npm run dev -- validate-index
```

Include all configured preview Git/npm sources explicitly:

```bash
npm run dev -- sync-sources --include-preview
npm run dev -- rebuild-sources --include-preview
```

For the maximum local corpus, synchronize and index every configured stable and preview source:

```bash
npm run dev -- sync-sources --include-preview
npm run dev -- rebuild-sources --include-preview
npm run dev -- validate-index
npm run dev -- status --json
```

Preview material remains excluded from normal retrieval unless the query or request explicitly asks for preview material.

The environment equivalent is:

```text
BEDROCK_MCP_INCLUDE_PREVIEW=true
```

A custom checkout root can be supplied as the positional argument to both source commands.

Synchronization is fail-closed: existing checkouts must have the configured origin and branch, a resolvable revision, and a clean worktree. Updates are fast-forward-only. Dirty, locally-ahead, divergent, detached, wrong-origin, wrong-branch, symlinked, or otherwise invalid checkouts are rejected rather than reset.

New clones use blobless single-branch partial clones. Whole-repository sources keep their normal worktree. `sparsePaths` is opt-in per source and is used only where the registry explicitly identifies a useful subtree; large binary/assets-only material is excluded from the Bedrock OSS example source through include rules.

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

`status` reports schema/integrity state, database size, document/chunk/identifier counts, FTS consistency, and per-source revision/coverage. The public `list_sources` tool additionally exposes read-only source health, last indexing time, and exact duplicate-chunk percentage.

Create an online-consistent backup using Node's SQLite backup API:

```bash
npm run dev -- backup
npm run dev -- backup /srv/bedrock-backups --retain=14
```

A snapshot contains `bedrock.db`, `semantic.db` when present, repository `config/`, curated `knowledge/local/`, and a manifest. Symlinks and non-regular files in copied project material are skipped. The default destination is `data/backups/` with seven retained snapshots. Production scheduled refreshes create this backup **before** source synchronization/rebuild.

Run the stable/default retrieval-quality suite against a published stable index:

```bash
npm run dev -- benchmark
npm run dev -- benchmark --json
```

The default suite is `benchmarks/search-queries.json`. It covers exact Script API/runtime chains, Bedrock components, Molang, manifests, stable npm module/version questions, dynamic properties, commands, scoreboard/dimensions, animations, and natural-language development tasks.

For a comprehensive index built with preview sources enabled, run the dedicated preview/beta suite:

```bash
npm run dev -- benchmark benchmarks/search-queries-preview.json
npm run dev -- benchmark benchmarks/search-queries-preview.json --json
```

The preview suite covers current beta `@minecraft/*` package metadata, `PlayerInputPermissions`, GameTest, Editor extensions, schemas, protocol documentation, preview Bedrock samples, and beta scripting samples.

Benchmarks report MRR, Recall@3, Recall@5, NDCG@5, exact Top-1, natural Top-3, and useful Top-5. Relevance can require the correct identifier, source, category, channel, module, or path. Critical cases also use `requiredTopK`, and **every required case must pass** in addition to the aggregate thresholds. The command exits nonzero when either aggregate targets or a required rank gate fails.

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
