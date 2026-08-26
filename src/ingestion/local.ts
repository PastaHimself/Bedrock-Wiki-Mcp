import { readdir, readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { ParsedDocument } from "../models/document.js";
import type { SourceDescriptor } from "../models/source.js";
import { ingestDocument } from "./pipeline.js";

const DEFAULT_MAX_FILE_BYTES = 2_000_000;
const DEFAULT_EXTENSIONS = new Set([".md", ".mdx", ".json", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".txt"]);
const IGNORED_DIRECTORIES = new Set([".git", "node_modules", "dist"]);

export interface LocalIngestionOptions {
  maxFileBytes?: number;
  extensions?: readonly string[];
}

function toPosixPath(value: string): string {
  return value.split(sep).join("/");
}

function assertInsideRoot(root: string, candidate: string): void {
  const rel = relative(root, candidate);
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) return;
  throw new Error(`Refusing to ingest path outside source root: ${candidate}`);
}

async function collectFiles(root: string, current: string, extensions: ReadonlySet<string>, output: string[]): Promise<void> {
  assertInsideRoot(root, current);
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name, "en"));

  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const absolutePath = resolve(current, entry.name);
    assertInsideRoot(root, absolutePath);

    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name)) await collectFiles(root, absolutePath, extensions, output);
      continue;
    }

    if (entry.isFile() && extensions.has(extname(entry.name).toLocaleLowerCase("en-US"))) {
      output.push(absolutePath);
    }
  }
}

export async function ingestLocalDirectory(
  directory: string,
  source: SourceDescriptor,
  options: LocalIngestionOptions = {},
): Promise<ParsedDocument[]> {
  const root = resolve(directory);
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes <= 0) throw new RangeError("maxFileBytes must be a positive safe integer");

  const extensions = new Set((options.extensions ?? [...DEFAULT_EXTENSIONS]).map((value) => value.toLocaleLowerCase("en-US")));
  const files: string[] = [];
  await collectFiles(root, root, extensions, files);

  const documents: ParsedDocument[] = [];
  for (const file of files) {
    const info = await stat(file);
    if (info.size > maxFileBytes) continue;
    const content = await readFile(file, "utf8");
    const path = toPosixPath(relative(root, file));
    documents.push(
      ingestDocument({
        source,
        path,
        content,
        sourceModifiedAt: info.mtime.toISOString(),
      }),
    );
  }

  return documents;
}
