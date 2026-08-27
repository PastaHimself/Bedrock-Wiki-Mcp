import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { openSourceCheckout, sourceCheckoutRoot, validateSourceCheckoutDirectory } from "./checkout.js";
import { loadSourceRegistry, selectConfiguredSources, type SourceConfigEntry } from "./config.js";

const DEFAULT_GIT_TIMEOUT_MS = 180_000;
const MAX_GIT_OUTPUT_BYTES = 2_000_000;

export type SourceSyncStatus = "cloned" | "updated" | "unchanged";

export interface SourceSyncStats {
  sourceId: string;
  branch: string;
  status: SourceSyncStatus;
  revision: string;
  previousRevision?: string;
}

export interface SyncConfiguredSourcesOptions {
  dataDir: string;
  checkoutRoot?: string;
  configPath?: string;
  includePreview?: boolean;
  gitTimeoutMs?: number;
}

export interface SyncConfiguredSourcesResult {
  checkoutRoot: string;
  sources: SourceSyncStats[];
}

interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

function gitTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_GIT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1_000 || timeout > 900_000) {
    throw new RangeError("gitTimeoutMs must be an integer between 1000 and 900000");
  }
  return timeout;
}

function sanitizedGitDetail(stderr: string): string {
  return stderr
    .replace(/https?:\/\/[^@\s/]+:[^@\s]+@/gi, "https://***@")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function runGit(
  args: readonly string[],
  options: { cwd?: string; timeoutMs: number; allowedExitCodes?: readonly number[] },
): Promise<GitResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      "git",
      [...args],
      {
        ...(options.cwd ? { cwd: options.cwd } : {}),
        encoding: "utf8",
        timeout: options.timeoutMs,
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
        },
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolvePromise({ stdout, stderr, code: 0 });
          return;
        }

        const errorCode = (error as NodeJS.ErrnoException).code;
        if (errorCode === "ENOENT") {
          rejectPromise(new Error("GIT_UNAVAILABLE: git executable was not found on PATH"));
          return;
        }

        const numericCode = typeof errorCode === "number" ? errorCode : Number(errorCode);
        if (Number.isInteger(numericCode) && options.allowedExitCodes?.includes(numericCode)) {
          resolvePromise({ stdout, stderr, code: numericCode });
          return;
        }

        const detail = sanitizedGitDetail(stderr);
        rejectPromise(new Error(
          `GIT_COMMAND_FAILED: git ${args[0] ?? "command"} failed${detail ? `: ${detail}` : ""}`,
        ));
      },
    );
  });
}

async function ensureCheckoutRoot(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`SOURCE_ROOT_INVALID: checkout root must be a real directory: ${path}`);
  }
}

async function targetExists(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`SOURCE_CHECKOUT_INVALID: checkout target must be a real directory: ${path}`);
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function cloneSource(
  checkoutRoot: string,
  config: SourceConfigEntry,
  timeoutMs: number,
): Promise<SourceSyncStats> {
  const target = resolve(checkoutRoot, config.id);
  const temporary = join(checkoutRoot, `.${config.id}-${randomUUID()}.cloning`);

  try {
    await runGit(
      [
        "clone",
        "--filter=blob:none",
        "--single-branch",
        "--no-tags",
        "--branch",
        config.branch,
        "--",
        config.repository,
        temporary,
      ],
      { cwd: checkoutRoot, timeoutMs },
    );
    const checkout = await validateSourceCheckoutDirectory(temporary, config);
    await rename(temporary, target);
    return {
      sourceId: config.id,
      branch: config.branch,
      status: "cloned",
      revision: checkout.revision,
    };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

async function assertCleanWorktree(directory: string, sourceId: string, timeoutMs: number): Promise<void> {
  const status = await runGit(["status", "--porcelain=v1", "--untracked-files=normal"], { cwd: directory, timeoutMs });
  if (status.stdout.trim().length > 0) {
    throw new Error(`SOURCE_WORKTREE_DIRTY: ${sourceId} contains tracked or untracked local changes`);
  }
}

async function updateSource(
  checkoutRoot: string,
  config: SourceConfigEntry,
  timeoutMs: number,
): Promise<SourceSyncStats> {
  const before = await openSourceCheckout(checkoutRoot, config);
  await assertCleanWorktree(before.directory, config.id, timeoutMs);

  const remoteRef = `refs/remotes/origin/${config.branch}`;
  await runGit(
    ["fetch", "--prune", "--no-tags", "origin", `refs/heads/${config.branch}:${remoteRef}`],
    { cwd: before.directory, timeoutMs },
  );
  const remote = await runGit(["rev-parse", "--verify", `${remoteRef}^{commit}`], { cwd: before.directory, timeoutMs });
  const remoteRevision = remote.stdout.trim().toLocaleLowerCase("en-US");
  if (!/^[0-9a-f]{40,64}$/.test(remoteRevision)) {
    throw new Error(`SOURCE_REMOTE_REVISION_INVALID: ${config.id} remote branch did not resolve to a commit`);
  }

  if (remoteRevision === before.revision) {
    return {
      sourceId: config.id,
      branch: config.branch,
      status: "unchanged",
      revision: before.revision,
    };
  }

  const ancestry = await runGit(
    ["merge-base", "--is-ancestor", before.revision, remoteRevision],
    { cwd: before.directory, timeoutMs, allowedExitCodes: [1] },
  );
  if (ancestry.code !== 0) {
    throw new Error(`SOURCE_DIVERGED: ${config.id} cannot be fast-forwarded to origin/${config.branch}`);
  }

  await runGit(["merge", "--ff-only", "--no-edit", remoteRef], { cwd: before.directory, timeoutMs });
  await assertCleanWorktree(before.directory, config.id, timeoutMs);
  const after = await validateSourceCheckoutDirectory(before.directory, config);
  if (after.revision !== remoteRevision) {
    throw new Error(`SOURCE_SYNC_INCOMPLETE: ${config.id} did not reach the fetched remote revision`);
  }

  return {
    sourceId: config.id,
    branch: config.branch,
    status: "updated",
    previousRevision: before.revision,
    revision: after.revision,
  };
}

export async function syncConfiguredSources(
  options: SyncConfiguredSourcesOptions,
): Promise<SyncConfiguredSourcesResult> {
  const dataDir = resolve(options.dataDir);
  const checkoutRoot = resolve(options.checkoutRoot ?? sourceCheckoutRoot(dataDir));
  const registry = await loadSourceRegistry(options.configPath ?? "config/sources.json");
  const selected = selectConfiguredSources(registry.sources, options.includePreview ?? false);
  if (selected.length === 0) throw new Error("SOURCE_REGISTRY_EMPTY: no enabled sources were selected");

  const timeoutMs = gitTimeout(options.gitTimeoutMs);
  await ensureCheckoutRoot(checkoutRoot);
  const sources: SourceSyncStats[] = [];

  for (const config of selected) {
    const target = resolve(checkoutRoot, config.id);
    sources.push(
      (await targetExists(target))
        ? await updateSource(checkoutRoot, config, timeoutMs)
        : await cloneSource(checkoutRoot, config, timeoutMs),
    );
  }

  return { checkoutRoot, sources };
}
