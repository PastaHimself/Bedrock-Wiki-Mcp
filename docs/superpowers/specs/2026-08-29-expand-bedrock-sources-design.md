# Expand Bedrock knowledge sources

## Goal

Expand the Bedrock Wiki MCP knowledge corpus so the available disk is used for
more useful Minecraft Bedrock development material. The expansion will add
validated GitHub repositories covering editor documentation, schemas, Script
API examples, modeling and animation tooling, language-server diagnostics, and
addon frameworks. Existing preview Git and npm sources will be synchronized in
the full-source workflow as well.

The index remains read-only at runtime. Source checkouts and generated SQLite
indexes remain local runtime data and are not committed to this repository.

## Source policy

Each source is represented by one registry entry with an explicit repository,
branch, trust tier, release channel, and indexable path filters. The source
synchronizer will continue using blobless, single-branch clones. Sparse paths
and include/exclude patterns will keep dependencies, build output, tests,
images, and unrelated binary assets out of the knowledge corpus.

Preview material remains opt-in through the existing `--include-preview` flag;
the full synchronization/rebuild run will use that flag so all configured
stable and preview sources are available in the local index without changing
the server's conservative default retrieval behavior.

## New Git sources

| ID | Repository and branch | Channel/tier | Indexed material |
| --- | --- | --- | --- |
| `bridge_core_docs` | `bridge-core/docs` `main` | stable / 3 | Bridge editor guides and Markdown reference material |
| `bridge_core_editor_packages` | `bridge-core/editor-packages` `main` | stable / 3 | Bridge schemas, file definitions, package JSON, and related docs |
| `blockception_language_server` | `Blockception/minecraft-bedrock-language-server` `main` | stable / 3 | Documentation, diagnostics, project helpers, IDE integrations, and package source |
| `blockception_json_schemas` | `Blockception/Minecraft-bedrock-json-schemas` `main` | stable / 3 | Behavior/resource-pack schemas, descriptions, and schema docs |
| `jayly_scriptapi` | `JaylyDev/ScriptAPI` `stable` | stable / 3 | Community Script API examples, packages, and tooling |
| `blockbench` | `JannisX11/blockbench` `master` | stable / 3 | Blockbench documentation, Bedrock format code, and type definitions |
| `jannis_bedrock_schemas` | `JannisX11/bedrock-json-schemas` `master` | unknown / 3 | Historical Bedrock manifest, animation, geometry, and render-controller schemas |
| `nusiq_mcblend` | `Nusiq/mcblend` `master` | stable / 3 | Mcblend Markdown guides for Bedrock modeling and animation |
| `bedrock_core_server` | `bedrock-core/server` `main` | stable / 3 | Addon interoperability framework guides and TypeScript packages |
| `minecraft_addon_toolchain` | `minecraft-addon-tools/minecraft-addon-toolchain` `master` | unknown / 3 | Historical addon build and packaging documentation/source |

The registry tests will assert that all ten IDs are unique, use the validated
repository and branch values, preserve the intended channel classification,
and contain the expected path filters. Duplicate evidence between official,
community, and historical sources is allowed; the existing conservative
deduplication layer decides which result survives ranking.

## Index and storage behavior

The implementation will not store binary media merely to consume disk. The
new repositories will add text, JSON, JavaScript, TypeScript, schemas, and
Markdown that the current ingestion pipeline can parse. Existing source
checkout and SQLite index locations remain unchanged under `BEDROCK_MCP_DATA_DIR`.

After configuration and tests pass, the full workflow is:

```bash
npm run dev -- sync-sources --include-preview
npm run dev -- rebuild-sources --include-preview
npm run dev -- validate-index
npm run dev -- status --json
```

The rebuild is transactional and must publish only after validation succeeds.
If a repository is unreachable, has an invalid branch, or produces no
indexable documents, the run must fail clearly rather than publishing a
partial index.

## Testing and acceptance criteria

1. Source configuration tests cover all ten new source entries, unique IDs,
   branch/channel values, and representative include/sparse rules.
2. TypeScript type-checking, the complete Vitest suite, and the production
   build pass.
3. Stable and preview synchronization complete without dirty or divergent
   checkouts.
4. The rebuilt SQLite index validates successfully and reports every selected
   source with non-zero document/chunk counts.
5. Existing source-selection semantics remain unchanged when
   `--include-preview` is omitted.
6. The final GitHub change contains only the registry, tests, and supporting
   documentation; generated checkouts, databases, dependency folders, and
   model caches remain untracked runtime data.
