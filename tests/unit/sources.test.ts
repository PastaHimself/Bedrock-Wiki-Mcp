import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSourceRegistry, type SourceConfigEntry } from "../../src/sources/config.js";
import { openSourceCheckout, sourceFileUrls, walkSourceCheckoutDocuments } from "../../src/sources/checkout.js";
import { readGitHeadState, readGitRevision } from "../../src/sources/git-revision.js";
import { createSourcePathFilter, pathMatchesGlob } from "../../src/sources/glob.js";

const temporaryDirectories: string[] = [];
const REVISION = "0123456789abcdef0123456789abcdef01234567";
const DEFAULT_REPOSITORY = "https://github.com/example/docs.git";

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "bedrock-mcp-source-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeLooseGitRevision(
  checkout: string,
  revision = REVISION,
  branch = "main",
  repository = DEFAULT_REPOSITORY,
): Promise<void> {
  await mkdir(join(checkout, ".git", "refs", "heads"), { recursive: true });
  await writeFile(join(checkout, ".git", "HEAD"), `ref: refs/heads/${branch}\n`);
  await writeFile(join(checkout, ".git", "refs", "heads", branch), `${revision}\n`);
  await writeFile(join(checkout, ".git", "config"), `[remote \"origin\"]\n\turl = ${repository}\n`);
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("source configuration", () => {
  it("loads validated source definitions and defaults sources to enabled", async () => {
    const root = await temporaryDirectory();
    const path = join(root, "sources.json");
    await writeFile(path, JSON.stringify({
      sources: [{
        id: "official_docs",
        name: "Official docs",
        type: "git",
        tier: 1,
        repository: DEFAULT_REPOSITORY,
        branch: "main",
        channel: "stable",
        include: ["docs/**"],
      }],
    }));

    const registry = await loadSourceRegistry(path);
    expect(registry.sources).toHaveLength(1);
    expect(registry.sources[0]?.defaultEnabled).toBe(true);
    expect(registry.sources[0]?.include).toEqual(["docs/**"]);
  });

  it("rejects duplicate source IDs", async () => {
    const root = await temporaryDirectory();
    const path = join(root, "sources.json");
    const source = {
      id: "duplicate",
      name: "Duplicate",
      type: "git",
      tier: 1,
      repository: DEFAULT_REPOSITORY,
      branch: "main",
      channel: "stable",
    };
    await writeFile(path, JSON.stringify({ sources: [source, source] }));
    await expect(loadSourceRegistry(path)).rejects.toThrow("Duplicate source id");
  });
});

describe("source path filtering", () => {
  it("supports double-star, star and question-mark matching", () => {
    expect(pathMatchesGlob("creator/Documents/entities/test.md", "creator/Documents/**")).toBe(true);
    expect(pathMatchesGlob("scripts/main.ts", "scripts/*.ts")).toBe(true);
    expect(pathMatchesGlob("scripts/nested/main.ts", "scripts/*.ts")).toBe(false);
    expect(pathMatchesGlob("a/x.json", "a/?.json")).toBe(true);
  });

  it("lets excludes override includes", () => {
    const filter = createSourcePathFilter(["creator/**"], ["creator/PriorScriptAPI/**"]);
    expect(filter("creator/ScriptAPI/server/System.md")).toBe(true);
    expect(filter("creator/PriorScriptAPI/server/System.md")).toBe(false);
    expect(filter("samples/example.json")).toBe(false);
  });
});

describe("source checkout ingestion", () => {
  it("reads a checkout revision and attaches filtered repository provenance", async () => {
    const checkoutRoot = await temporaryDirectory();
    const checkout = join(checkoutRoot, "official_docs");
    await mkdir(join(checkout, "docs"), { recursive: true });
    await mkdir(join(checkout, "ignored"), { recursive: true });
    await writeLooseGitRevision(checkout);
    await writeFile(join(checkout, "docs", "health.md"), "# Health\nUse `minecraft:health` for entity health.");
    await writeFile(join(checkout, "ignored", "skip.md"), "# Skip\nShould not be indexed.");
    await writeFile(join(checkout, "docs", "texture.png"), "not a real image but still an excluded extension");

    expect(await readGitRevision(checkout)).toBe(REVISION);
    expect(await readGitHeadState(checkout)).toEqual({
      revision: REVISION,
      headRef: "refs/heads/main",
      originUrl: DEFAULT_REPOSITORY,
    });

    const config: SourceConfigEntry = {
      id: "official_docs",
      name: "Official docs",
      type: "git",
      tier: 1,
      repository: DEFAULT_REPOSITORY,
      branch: "main",
      channel: "stable",
      include: ["docs/**"],
      defaultEnabled: true,
    };
    const opened = await openSourceCheckout(checkoutRoot, config);
    const documents = [];
    for await (const document of walkSourceCheckoutDocuments(opened)) documents.push(document);

    expect(documents).toHaveLength(1);
    expect(documents[0]?.metadata.path).toBe("docs/health.md");
    expect(documents[0]?.metadata.revision).toBe(REVISION);
    expect(documents[0]?.metadata.sourceFileHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(documents[0]?.metadata.canonicalUrl).toBe("https://github.com/example/docs/blob/main/docs/health.md");
    expect(documents[0]?.metadata.revisionUrl).toBe(`https://github.com/example/docs/blob/${REVISION}/docs/health.md`);
  });

  it("rejects a symbolic checkout on the wrong configured branch", async () => {
    const checkoutRoot = await temporaryDirectory();
    const checkout = join(checkoutRoot, "stable_docs");
    await mkdir(checkout, { recursive: true });
    await writeLooseGitRevision(checkout, REVISION, "preview");

    const config: SourceConfigEntry = {
      id: "stable_docs",
      name: "Stable docs",
      type: "git",
      tier: 1,
      repository: DEFAULT_REPOSITORY,
      branch: "main",
      channel: "stable",
      defaultEnabled: true,
    };

    await expect(openSourceCheckout(checkoutRoot, config)).rejects.toThrow("SOURCE_BRANCH_MISMATCH");
  });

  it("rejects a checkout whose origin does not match the trusted source", async () => {
    const checkoutRoot = await temporaryDirectory();
    const checkout = join(checkoutRoot, "official_docs");
    await mkdir(checkout, { recursive: true });
    await writeLooseGitRevision(checkout, REVISION, "main", "https://github.com/attacker/fake-docs.git");

    const config: SourceConfigEntry = {
      id: "official_docs",
      name: "Official docs",
      type: "git",
      tier: 1,
      repository: DEFAULT_REPOSITORY,
      branch: "main",
      channel: "stable",
      defaultEnabled: true,
    };

    await expect(openSourceCheckout(checkoutRoot, config)).rejects.toThrow("SOURCE_ORIGIN_MISMATCH");
  });

  it("accepts equivalent HTTPS and SSH GitHub origin identities", async () => {
    const checkoutRoot = await temporaryDirectory();
    const checkout = join(checkoutRoot, "official_docs");
    await mkdir(checkout, { recursive: true });
    await writeLooseGitRevision(checkout, REVISION, "main", "git@github.com:example/docs.git");

    const config: SourceConfigEntry = {
      id: "official_docs",
      name: "Official docs",
      type: "git",
      tier: 1,
      repository: DEFAULT_REPOSITORY,
      branch: "main",
      channel: "stable",
      defaultEnabled: true,
    };

    await expect(openSourceCheckout(checkoutRoot, config)).resolves.toMatchObject({ revision: REVISION });
  });

  it("builds URL-safe branch and file provenance", () => {
    const urls = sourceFileUrls(
      { repository: "https://github.com/example/repo.git", branch: "feature/test branch" },
      "folder/file name.md",
      REVISION,
    );
    expect(urls.canonicalUrl).toBe("https://github.com/example/repo/blob/feature%2Ftest%20branch/folder/file%20name.md");
    expect(urls.revisionUrl).toContain(`/blob/${REVISION}/folder/file%20name.md`);
  });
});
