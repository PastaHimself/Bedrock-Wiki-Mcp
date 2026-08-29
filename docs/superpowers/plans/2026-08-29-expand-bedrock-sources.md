# Expand Bedrock knowledge sources Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add ten validated GitHub knowledge sources, run the full stable-plus-preview ingestion workflow, and publish the tested registry expansion.

**Architecture:** Keep discovery declarative in `config/sources.json`. Each repository gets an explicit branch, trust tier, release channel, sparse checkout scope, and parser-compatible include/exclude filters. The existing synchronizer, transactional SQLite rebuild, deduplication, and preview-selection rules remain the execution path.

**Tech Stack:** Node.js 24, TypeScript, Zod, Vitest, Git partial/sparse checkouts, SQLite/FTS5, GitHub repository integration.

## Global Constraints

- Use only validated public GitHub repositories and branches recorded in the approved design.
- Keep preview material opt-in when `--include-preview` is omitted.
- Exclude dependencies, build output, tests, images, and unrelated binary assets from indexed paths.
- Keep generated source checkouts, databases, dependency folders, and model caches out of Git.
- Do not publish a rebuilt index unless transactional validation succeeds.
- Preserve existing source-selection semantics for all existing entries.

---

### Task 1: Add and validate the ten source entries

**Files:**
- Modify: `tests/unit/source-config.test.ts`
- Modify: `config/sources.json`

**Interfaces:**
- Consumes: `loadSources()` and the current source registry JSON shape.
- Produces: ten `SourceDefinition` entries consumed by `loadSourceRegistry()` and `syncConfiguredSources()`.

- [ ] **Step 1: Write the failing registry test**

Add this test inside the existing source-configuration `describe` block:

```ts
  it("includes the expanded GitHub knowledge sources with safe scopes", () => {
    const expected = [
      ["bridge_core_docs", "https://github.com/bridge-core/docs.git", "main", "stable", ["docs"]],
      ["bridge_core_editor_packages", "https://github.com/bridge-core/editor-packages.git", "main", "stable", ["packages"]],
      ["blockception_language_server", "https://github.com/Blockception/minecraft-bedrock-language-server.git", "main", "stable", ["documentation", "ide", "packages", "tools"]],
      ["blockception_json_schemas", "https://github.com/Blockception/Minecraft-bedrock-json-schemas.git", "main", "stable", ["behavior", "docs", "general", "language", "resource", "skinpacks", "source", "worldgen"]],
      ["jayly_scriptapi", "https://github.com/JaylyDev/ScriptAPI.git", "stable", "stable", ["packages", "scripts", "tools"]],
      ["blockbench", "https://github.com/JannisX11/blockbench.git", "master", "stable", ["content", "js", "types"]],
      ["jannis_bedrock_schemas", "https://github.com/JannisX11/bedrock-json-schemas.git", "master", "unknown", undefined],
      ["nusiq_mcblend", "https://github.com/Nusiq/mcblend.git", "master", "stable", ["docs"]],
      ["bedrock_core_server", "https://github.com/bedrock-core/server.git", "main", "stable", ["packages", "types"]],
      ["minecraft_addon_toolchain", "https://github.com/minecraft-addon-tools/minecraft-addon-toolchain.git", "master", "unknown", ["packages"]],
    ] as const;

    const byId = new Map(loadSources().map((source) => [source.id, source]));
    for (const [id, repository, branch, channel, sparsePaths] of expected) {
      const source = byId.get(id);
      expect(source, id).toBeDefined();
      expect(source?.repository, id).toBe(repository);
      expect(source?.branch, id).toBe(branch);
      expect(source?.channel, id).toBe(channel);
      expect(source?.tier, id).toBe(3);
      expect(source?.defaultEnabled ?? true, id).toBe(true);
      if (sparsePaths) expect(source?.sparsePaths, id).toEqual(sparsePaths);
    }
  });
```

- [ ] **Step 2: Run the focused test and verify it fails**

```bash
npm test -- tests/unit/source-config.test.ts
```

Expected: the existing tests pass and the new test fails because the ten IDs are absent from `config/sources.json`.

- [ ] **Step 3: Add the ten registry entries**

Append the ten source objects from the approved design to the `sources` array. Their exact IDs, repositories, branches, channels, and sparse paths are:

| ID | Repository | Branch | Channel | Sparse paths |
| --- | --- | --- | --- | --- |
| `bridge_core_docs` | `https://github.com/bridge-core/docs.git` | `main` | `stable` | `docs` |
| `bridge_core_editor_packages` | `https://github.com/bridge-core/editor-packages.git` | `main` | `stable` | `packages` |
| `blockception_language_server` | `https://github.com/Blockception/minecraft-bedrock-language-server.git` | `main` | `stable` | `documentation, ide, packages, tools` |
| `blockception_json_schemas` | `https://github.com/Blockception/Minecraft-bedrock-json-schemas.git` | `main` | `stable` | `behavior, docs, general, language, resource, skinpacks, source, worldgen` |
| `jayly_scriptapi` | `https://github.com/JaylyDev/ScriptAPI.git` | `stable` | `stable` | `packages, scripts, tools` |
| `blockbench` | `https://github.com/JannisX11/blockbench.git` | `master` | `stable` | `content, js, types` |
| `jannis_bedrock_schemas` | `https://github.com/JannisX11/bedrock-json-schemas.git` | `master` | `unknown` | none |
| `nusiq_mcblend` | `https://github.com/Nusiq/mcblend.git` | `master` | `stable` | `docs` |
| `bedrock_core_server` | `https://github.com/bedrock-core/server.git` | `main` | `stable` | `packages, types` |
| `minecraft_addon_toolchain` | `https://github.com/minecraft-addon-tools/minecraft-addon-toolchain.git` | `master` | `unknown` | `packages` |

Every entry uses tier `3`, `defaultEnabled: true`, and the parser-compatible include/exclude patterns specified in the approved design.

- [ ] **Step 4: Run the focused tests and formatting checks**

```bash
npm test -- tests/unit/source-config.test.ts
git diff --check
```

Expected: all source-configuration tests pass and Git reports no whitespace errors.

- [ ] **Step 5: Commit the registry/test change**

```bash
git add config/sources.json tests/unit/source-config.test.ts
git commit -m "feat: expand Bedrock knowledge sources"
```

### Task 2: Document the expanded full-corpus workflow

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: the ten new source IDs and the existing `--include-preview` CLI option.
- Produces: user-facing source coverage documentation and reproducible full-corpus commands.

- [ ] **Step 1: Add the ten repositories to the knowledge-source list**

Add the ten repository names and their roles from Task 1 after the existing `bedrock_oss_examples` entry:

```markdown
9. `bridge-core/docs` — bridge. editor guides and reference documentation.
10. `bridge-core/editor-packages` — bridge. schemas and Bedrock file definitions.
11. `Blockception/minecraft-bedrock-language-server` — language-server diagnostics, project helpers, and IDE tooling.
12. `Blockception/Minecraft-bedrock-json-schemas` — community behavior/resource-pack schemas.
13. `JaylyDev/ScriptAPI` `stable` — community Script API samples and packages.
14. `JannisX11/blockbench` — Blockbench Bedrock format implementation and type definitions.
15. `Nusiq/mcblend` — Bedrock modeling and animation documentation.
16. `bedrock-core/server` — addon interoperability framework documentation and packages.
17. `JannisX11/bedrock-json-schemas` — historical compatibility schemas.
18. `minecraft-addon-tools/minecraft-addon-toolchain` — historical addon build tooling.
```

- [ ] **Step 2: Add the full-corpus command block**

Add this after the existing preview synchronization commands:

```markdown
For the maximum local corpus, synchronize and index every configured stable and preview source:

```bash
npm run dev -- sync-sources --include-preview
npm run dev -- rebuild-sources --include-preview
npm run dev -- validate-index
npm run dev -- status --json
```

Preview material remains excluded from normal retrieval unless the query or request explicitly asks for preview material.
```

- [ ] **Step 3: Verify and commit the documentation**

```bash
git diff --check
git diff -- README.md
git add README.md
git commit -m "docs: describe expanded Bedrock source corpus"
```

Expected: the README names all ten new sources and documents the exact full-corpus commands without changing default preview selection.

### Task 3: Run code validation and full-source ingestion

**Files:**
- Read: `config/sources.json`
- Read: `config/npm-sources.json`
- Generate locally under: `data/sources/`, `data/index/`, and npm snapshot paths; do not commit generated output.

**Interfaces:**
- Consumes: the expanded source registry and existing npm registry.
- Produces: a validated SQLite index containing every selected stable and preview source.

- [ ] **Step 1: Run the complete automated validation**

```bash
npm run check
```

Expected: type-checking passes, all Vitest files pass, and the production TypeScript build completes successfully.

- [ ] **Step 2: Synchronize all configured Git and npm sources**

```bash
npm run dev -- sync-sources --include-preview
```

Expected: every configured source reports `cloned`, `updated`, or `unchanged`; stable and preview Git sources plus both npm snapshots complete without branch, origin, dirty-worktree, or empty-source errors.

- [ ] **Step 3: Rebuild the transactional SQLite index**

```bash
npm run dev -- rebuild-sources --include-preview
```

Expected: every selected source reports non-zero document and chunk counts, and `data/index/bedrock.db` is published only after validation.

- [ ] **Step 4: Validate and inspect source coverage**

```bash
npm run dev -- validate-index
npm run dev -- status --json
```

Expected: validation returns `ok: true`; status includes every selected source, non-zero totals, current revisions, and no failed source-health entries.

- [ ] **Step 5: Confirm generated data stays untracked**

```bash
git status --short
du -sh data
```

Expected: generated checkouts and indexes do not appear as Git changes, while the `data` size reflects the expanded corpus.

### Task 4: Publish the tested change through GitHub

**Files:**
- Modify remotely: `PastaHimself/Bedrock-Wiki-Mcp` branch `feature/expand-bedrock-sources`
- Publish: a pull request targeting `main`

**Interfaces:**
- Consumes: the local feature-branch commits and validated working tree.
- Produces: a GitHub branch containing the implementation and a pull request with the validation summary.

- [ ] **Step 1: Confirm the final local commit set**

```bash
git status --short --branch
git log --oneline --decorate -5
```

Expected: the feature branch is clean and contains the design, source/test, and documentation commits.

- [ ] **Step 2: Publish the feature branch through GitHub**

Create or update the remote `feature/expand-bedrock-sources` branch from the local implementation commits, preserving the existing `main` branch.

- [ ] **Step 3: Open the pull request**

Use this title and body:

```text
Title: Expand Bedrock knowledge sources

Body:
Adds ten validated GitHub sources for Bedrock editor documentation, schemas,
Script API samples, modeling/animation tools, diagnostics, and addon
frameworks. Documents the full stable-plus-preview synchronization workflow.

Validation:
- npm run check
- npm run dev -- sync-sources --include-preview
- npm run dev -- rebuild-sources --include-preview
- npm run dev -- validate-index
```

- [ ] **Step 4: Verify the remote branch and pull request**

Confirm that the remote branch contains the expected commits and that the pull request targets `main` with the validation summary intact.
