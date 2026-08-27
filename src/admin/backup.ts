import { copyFile, lstat, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { SERVICE_VERSION } from "../constants.js";

export interface BackupOptions {
  dataDir: string;
  destinationRoot?: string;
  projectRoot?: string;
  retain?: number;
  now?: Date;
}

export interface BackupResult {
  directory: string;
  createdAt: string;
  files: string[];
  removedBackups: string[];
}

function validateRetention(value: number | undefined): number {
  const retain = value ?? 7;
  if (!Number.isSafeInteger(retain) || retain < 1 || retain > 365) {
    throw new RangeError("retain must be an integer between 1 and 365");
  }
  return retain;
}

function backupDirectoryName(date: Date): string {
  if (Number.isNaN(date.getTime())) throw new RangeError("backup date is invalid");
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function backupDatabase(sourcePath: string, destinationPath: string): Promise<void> {
  const source = new DatabaseSync(sourcePath, { readOnly: true, timeout: 5_000 });
  try {
    await backup(source, destinationPath, { rate: 256 });
  } finally {
    source.close();
  }
}

async function copyTreeSafe(source: string, destination: string): Promise<string[]> {
  if (!(await exists(source))) return [];
  const copied: string[] = [];

  async function walk(currentSource: string, currentDestination: string): Promise<void> {
    const info = await lstat(currentSource);
    if (info.isSymbolicLink()) return;
    if (info.isDirectory()) {
      await mkdir(currentDestination, { recursive: true });
      const entries = await readdir(currentSource);
      for (const entry of entries.sort()) {
        await walk(join(currentSource, entry), join(currentDestination, entry));
      }
      return;
    }
    if (!info.isFile()) return;
    await mkdir(dirname(currentDestination), { recursive: true });
    await copyFile(currentSource, currentDestination);
    copied.push(currentDestination);
  }

  await walk(source, destination);
  return copied;
}

async function pruneBackups(root: string, retain: number, current: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isDirectory() && /^\d{8}T\d{6}Z$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const keep = new Set(candidates.slice(-retain));
  keep.add(current);
  const removed: string[] = [];
  for (const name of candidates) {
    if (keep.has(name)) continue;
    await rm(join(root, name), { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

export async function createBackup(options: BackupOptions): Promise<BackupResult> {
  const dataDir = resolve(options.dataDir);
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const root = resolve(options.destinationRoot ?? join(dataDir, "backups"));
  const retain = validateRetention(options.retain);
  const instant = options.now ?? new Date();
  const createdAt = instant.toISOString();
  const name = backupDirectoryName(instant);
  const directory = join(root, name);
  const lexicalPath = join(dataDir, "index", "bedrock.db");
  if (!(await exists(lexicalPath))) {
    throw new Error(`INDEX_UNAVAILABLE: no lexical index exists at ${lexicalPath}`);
  }

  await mkdir(root, { recursive: true });
  await mkdir(directory, { recursive: false });
  const files: string[] = [];
  try {
    const lexicalBackup = join(directory, "bedrock.db");
    await backupDatabase(lexicalPath, lexicalBackup);
    files.push(lexicalBackup);

    const semanticPath = join(dataDir, "index", "semantic.db");
    if (await exists(semanticPath)) {
      const semanticBackup = join(directory, "semantic.db");
      await backupDatabase(semanticPath, semanticBackup);
      files.push(semanticBackup);
    }

    files.push(...await copyTreeSafe(join(projectRoot, "config"), join(directory, "config")));
    files.push(...await copyTreeSafe(join(projectRoot, "knowledge", "local"), join(directory, "knowledge", "local")));

    const manifestPath = join(directory, "manifest.json");
    await writeFile(manifestPath, `${JSON.stringify({
      createdAt,
      serviceVersion: SERVICE_VERSION,
      sourceDataDir: dataDir,
      files: files.map((path) => path.slice(directory.length + 1)),
    }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    files.push(manifestPath);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }

  const removedBackups = await pruneBackups(root, retain, basename(directory));
  return {
    directory,
    createdAt,
    files: files.map((path) => path.slice(directory.length + 1)),
    removedBackups,
  };
}
