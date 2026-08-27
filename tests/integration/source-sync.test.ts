import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { openSourceCheckout } from "../../src/sources/checkout.js";
import { loadSourceRegistry } from "../../src/sources/config.js";
import { syncConfiguredSources } from "../../src/sources/sync.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "bedrock-mcp-sync-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return String(result.stdout).trim();
}

interface RemoteFixture {
  remoteUrl: string;
  seed: string;
}

async function makeRemote(root: string, name: string): Promise<RemoteFixture> {
  const remote = join(root, `${name}.git`);
  const seed = join(root, `${name}-seed`);
  await mkdir(remote, { recursive: true });
  await git(remote, "init", "--bare");
  await mkdir(seed, { recursive: true });
  await git(seed, "init", "-b", "main");
  await git(seed, "config", "user.name", "Bedrock MCP Test");
  await git(seed, "config", "user.email", "bedrock-mcp@example.invalid");
  await writeFile(join(seed, "README.md"), "version one\n");
  await git(seed, "add", "README.md");
  await git(seed, "commit", "-m", "initial");
  await git(seed, "remote", "add", "origin", pathToFileURL(remote).href);
  await git(seed, "push", "-u", "origin", "main");
  return { remoteUrl: pathToFileURL(remote).href, seed };
}

async function pushUpdate(fixture: RemoteFixture, text: string): Promise<string> {
  await writeFile(join(fixture.seed, "README.md"), text);
  await git(fixture.seed, "add", "README.md");
  await git(fixture.seed, "commit", "-m", "update");
  await git(fixture.seed, "push", "origin", "main");
  return git(fixture.seed, "rev-parse", "HEAD");
}

async function writeRegistry(path: string, repository: string, branch = "main"): Promise<void> {
  await writeFile(path, JSON.stringify({
    sources: [{
      id: "official_docs",
      name: "Official docs",
      type: "git",
      tier: 1,
      repository,
      branch,
      channel: "stable",
      include: ["**/*.md"],
    }],
  }));
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("configured source synchronization", () => {
  it("clones missing sources, reports unchanged state, and fast-forwards updates", async () => {
    const root = await temporaryDirectory();
    const fixture = await makeRemote(root, "remote");
    const dataDir = join(root, "data");
    const checkoutRoot = join(root, "checkouts");
    const configPath = join(root, "sources.json");
    await writeRegistry(configPath, fixture.remoteUrl);

    const first = await syncConfiguredSources({ dataDir, checkoutRoot, configPath, gitTimeoutMs: 30_000 });
    expect(first.sources).toHaveLength(1);
    expect(first.sources[0]?.status).toBe("cloned");
    const firstRevision = first.sources[0]?.revision;
    expect(firstRevision).toMatch(/^[0-9a-f]{40}$/);

    const unchanged = await syncConfiguredSources({ dataDir, checkoutRoot, configPath, gitTimeoutMs: 30_000 });
    expect(unchanged.sources[0]?.status).toBe("unchanged");
    expect(unchanged.sources[0]?.revision).toBe(firstRevision);

    const remoteRevision = await pushUpdate(fixture, "version two\n");
    const updated = await syncConfiguredSources({ dataDir, checkoutRoot, configPath, gitTimeoutMs: 30_000 });
    expect(updated.sources[0]?.status).toBe("updated");
    expect(updated.sources[0]?.previousRevision).toBe(firstRevision);
    expect(updated.sources[0]?.revision).toBe(remoteRevision);
    expect(await readFile(join(checkoutRoot, "official_docs", "README.md"), "utf8")).toBe("version two\n");

    const registry = await loadSourceRegistry(configPath);
    const checkout = await openSourceCheckout(checkoutRoot, registry.sources[0]!);
    expect(checkout.revision).toBe(remoteRevision);
  });

  it("refuses to overwrite dirty or locally divergent checkouts", async () => {
    const root = await temporaryDirectory();
    const fixture = await makeRemote(root, "remote");
    const dataDir = join(root, "data");
    const checkoutRoot = join(root, "checkouts");
    const configPath = join(root, "sources.json");
    await writeRegistry(configPath, fixture.remoteUrl);
    await syncConfiguredSources({ dataDir, checkoutRoot, configPath, gitTimeoutMs: 30_000 });

    const checkout = join(checkoutRoot, "official_docs");
    await writeFile(join(checkout, "README.md"), "local dirty change\n");
    await expect(syncConfiguredSources({ dataDir, checkoutRoot, configPath, gitTimeoutMs: 30_000 }))
      .rejects.toThrow("SOURCE_WORKTREE_DIRTY");

    await git(checkout, "checkout", "--", "README.md");
    await git(checkout, "config", "user.name", "Bedrock MCP Test");
    await git(checkout, "config", "user.email", "bedrock-mcp@example.invalid");
    await writeFile(join(checkout, "local.md"), "local commit\n");
    await git(checkout, "add", "local.md");
    await git(checkout, "commit", "-m", "local divergence");

    await expect(syncConfiguredSources({ dataDir, checkoutRoot, configPath, gitTimeoutMs: 30_000 }))
      .rejects.toThrow("SOURCE_DIVERGED");
  });

  it("rejects branch names that could be interpreted as Git options", async () => {
    const root = await temporaryDirectory();
    const fixture = await makeRemote(root, "remote");
    const configPath = join(root, "sources.json");
    await writeRegistry(configPath, fixture.remoteUrl, "--upload-pack=evil");
    await expect(loadSourceRegistry(configPath)).rejects.toThrow("branch is not a safe Git branch name");
  });
});
