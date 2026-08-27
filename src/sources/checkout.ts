import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ParsedDocument } from "../models/document.js";
import { walkLocalDocuments, type LocalIngestionOptions } from "../ingestion/local.js";
import { sourceDescriptor, type SourceConfigEntry } from "./config.js";
import { readGitHeadState } from "./git-revision.js";
import { createSourcePathFilter } from "./glob.js";

export interface SourceCheckout {
  readonly config: SourceConfigEntry;
  readonly directory: string;
  readonly revision: string;
}

function repositoryWebUrl(repository: string): string {
  return repository.replace(/\.git$/i, "").replace(/\/$/, "");
}

function normalizeRepositoryIdentity(repository: string): string {
  const trimmed = repository.trim().replace(/\/$/, "").replace(/\.git$/i, "");
  const scpLike = /^git@([^:]+):(.+)$/i.exec(trimmed);
  if (scpLike?.[1] && scpLike[2]) {
    return `${scpLike[1].toLocaleLowerCase("en-US")}/${scpLike[2].replace(/^\/+/, "").toLocaleLowerCase("en-US")}`;
  }

  try {
    const url = new URL(trimmed);
    const host = url.hostname.toLocaleLowerCase("en-US");
    const path = url.pathname.replace(/^\/+|\/+$/g, "").toLocaleLowerCase("en-US");
    return `${host}/${path}`;
  } catch {
    return trimmed.toLocaleLowerCase("en-US");
  }
}

function encodeRepositoryPath(path: string): string {
  return path.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

export function sourceFileUrls(
  config: Pick<SourceConfigEntry, "repository" | "branch">,
  path: string,
  revision?: string,
): { canonicalUrl: string; revisionUrl?: string } {
  const base = repositoryWebUrl(config.repository);
  const encodedPath = encodeRepositoryPath(path);
  const canonicalUrl = `${base}/blob/${encodeURIComponent(config.branch)}/${encodedPath}`;
  return {
    canonicalUrl,
    ...(revision ? { revisionUrl: `${base}/blob/${encodeURIComponent(revision)}/${encodedPath}` } : {}),
  };
}

export async function validateSourceCheckoutDirectory(
  directoryArg: string,
  config: SourceConfigEntry,
): Promise<SourceCheckout> {
  const directory = resolve(directoryArg);
  try {
    await access(directory);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(`SOURCE_CHECKOUT_MISSING: ${config.id} is not available at ${directory}`);
    }
    throw error;
  }

  const git = await readGitHeadState(directory);
  if (!git.revision) {
    throw new Error(`SOURCE_REVISION_UNRESOLVED: ${config.id} does not expose a resolvable Git commit`);
  }
  if (!git.originUrl) {
    throw new Error(`SOURCE_ORIGIN_MISSING: ${config.id} does not expose Git remote origin metadata`);
  }
  if (normalizeRepositoryIdentity(git.originUrl) !== normalizeRepositoryIdentity(config.repository)) {
    throw new Error(`SOURCE_ORIGIN_MISMATCH: ${config.id} checkout origin does not match configured repository`);
  }

  const expectedRef = `refs/heads/${config.branch}`;
  if (!git.headRef) {
    throw new Error(`SOURCE_DETACHED_HEAD: ${config.id} must be checked out on configured branch ${config.branch}`);
  }
  if (git.headRef !== expectedRef) {
    throw new Error(
      `SOURCE_BRANCH_MISMATCH: ${config.id} expects ${config.branch} but checkout HEAD is ${git.headRef.replace(/^refs\/heads\//, "")}`,
    );
  }

  return { config, directory, revision: git.revision };
}

export async function openSourceCheckout(
  checkoutRoot: string,
  config: SourceConfigEntry,
): Promise<SourceCheckout> {
  return validateSourceCheckoutDirectory(resolve(checkoutRoot, config.id), config);
}

export async function* walkSourceCheckoutDocuments(
  checkout: SourceCheckout,
  options: Omit<LocalIngestionOptions, "pathFilter" | "metadataForPath"> = {},
): AsyncGenerator<ParsedDocument> {
  const source = sourceDescriptor(checkout.config, checkout.revision);
  const pathFilter = createSourcePathFilter(checkout.config.include, checkout.config.exclude);

  yield* walkLocalDocuments(checkout.directory, source, {
    ...options,
    pathFilter,
    metadataForPath: (path) => sourceFileUrls(checkout.config, path, checkout.revision),
  });
}

export function sourceCheckoutRoot(dataDir: string): string {
  return join(dataDir, "sources");
}
