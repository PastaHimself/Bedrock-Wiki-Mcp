import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

const OBJECT_ID = /^[0-9a-f]{40,64}$/i;

export interface GitHeadState {
  readonly revision?: string;
  readonly headRef?: string;
  readonly originUrl?: string;
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function resolveGitDirectory(checkoutRoot: string): Promise<string | undefined> {
  const dotGit = resolve(checkoutRoot, ".git");
  try {
    const info = await stat(dotGit);
    if (info.isDirectory()) return dotGit;
    if (!info.isFile()) return undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }

  const marker = await readFile(dotGit, "utf8");
  const match = /^gitdir:\s*(.+)\s*$/im.exec(marker);
  if (!match?.[1]) return undefined;
  return isAbsolute(match[1]) ? resolve(match[1]) : resolve(dirname(dotGit), match[1]);
}

async function resolveCommonDirectory(gitDirectory: string): Promise<string> {
  const marker = (await readOptional(resolve(gitDirectory, "commondir")))?.trim();
  if (!marker) return gitDirectory;
  return isAbsolute(marker) ? resolve(marker) : resolve(gitDirectory, marker);
}

async function resolveRef(gitDirectory: string, commonDirectory: string, ref: string): Promise<string | undefined> {
  for (const root of gitDirectory === commonDirectory ? [gitDirectory] : [gitDirectory, commonDirectory]) {
    const loose = (await readOptional(resolve(root, ref)))?.trim();
    if (loose && OBJECT_ID.test(loose)) return loose.toLocaleLowerCase("en-US");
  }

  const packed = await readOptional(resolve(commonDirectory, "packed-refs"));
  if (!packed) return undefined;
  for (const line of packed.split(/\r?\n/)) {
    if (!line || line.startsWith("#") || line.startsWith("^")) continue;
    const separator = line.indexOf(" ");
    if (separator < 1) continue;
    const objectId = line.slice(0, separator);
    const packedRef = line.slice(separator + 1).trim();
    if (packedRef === ref && OBJECT_ID.test(objectId)) return objectId.toLocaleLowerCase("en-US");
  }
  return undefined;
}

function parseOriginUrl(config: string | undefined): string | undefined {
  if (!config) return undefined;
  let inOrigin = false;
  for (const rawLine of config.split(/\r?\n/)) {
    const line = rawLine.trim();
    const section = /^\[([^\]]+)\]$/.exec(line);
    if (section) {
      inOrigin = /^remote\s+"origin"$/i.test(section[1] ?? "");
      continue;
    }
    if (!inOrigin || line.startsWith("#") || line.startsWith(";")) continue;
    const setting = /^url\s*=\s*(.+)$/i.exec(line);
    if (setting?.[1]) return setting[1].trim();
  }
  return undefined;
}

export async function readGitHeadState(checkoutRoot: string): Promise<GitHeadState> {
  const gitDirectory = await resolveGitDirectory(checkoutRoot);
  if (!gitDirectory) return {};
  const commonDirectory = await resolveCommonDirectory(gitDirectory);
  const originUrl = parseOriginUrl(await readOptional(resolve(commonDirectory, "config")));
  const head = (await readOptional(resolve(gitDirectory, "HEAD")))?.trim();
  if (!head) return { ...(originUrl ? { originUrl } : {}) };
  if (OBJECT_ID.test(head)) {
    return {
      revision: head.toLocaleLowerCase("en-US"),
      ...(originUrl ? { originUrl } : {}),
    };
  }

  const refMatch = /^ref:\s*(.+)$/.exec(head);
  const headRef = refMatch?.[1]?.trim();
  if (!headRef) return { ...(originUrl ? { originUrl } : {}) };
  const revision = await resolveRef(gitDirectory, commonDirectory, headRef);
  return {
    headRef,
    ...(revision ? { revision } : {}),
    ...(originUrl ? { originUrl } : {}),
  };
}

export async function readGitRevision(checkoutRoot: string): Promise<string | undefined> {
  return (await readGitHeadState(checkoutRoot)).revision;
}
