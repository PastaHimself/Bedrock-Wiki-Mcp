import { readdir, readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { ParsedDocument } from "../models/document.js";
import type { SourceDescriptor } from "../models/source.js";
import { sha256Text } from "./hashing.js";
import { ingestDocument, type IngestInput } from "./pipeline.js";

const DEFAULT_MAX_FILE_BYTES = 2_000_000;
const DEFAULT_EXTENSIONS = new Set([
  ".md", ".mdx", ".json", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".txt",
  ".mcfunction", ".lang", ".material",
]);
const IGNORED_DIRECTORIES = new Set([".git", "node_modules", "dist"]);

export interface LocalDocumentMetadata {
  canonicalUrl?: string;
  revisionUrl?: string;
  sourceFileHash?: string;
  apiVersion?: string;
  minecraftVersion?: string;
}

export interface LocalIngestionOptions {
  maxFileBytes?: number;
  extensions?: readonly string[];
  pathFilter?: (path: string) => boolean;
  metadataForPath?: (path: string) => LocalDocumentMetadata;
}

function toPosixPath(value: string): string {
  return value.split(sep).join("/");
}

function assertInsideRoot(root: string, candidate: string): void {
  const rel = relative(root, candidate);
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) return;
  throw new Error(`Refusing to ingest path outside source root: ${candidate}`);
}

async function* walkFiles(
  root: string,
  current: string,
  extensions: ReadonlySet<string>,
): AsyncGenerator<string> {
  assertInsideRoot(root, current);
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name, "en"));

  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const absolutePath = resolve(current, entry.name);
    assertInsideRoot(root, absolutePath);

    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name)) yield* walkFiles(root, absolutePath, extensions);
      continue;
    }

    if (entry.isFile() && extensions.has(extname(entry.name).toLocaleLowerCase("en-US"))) {
      yield absolutePath;
    }
  }
}

export async function* walkLocalDocuments(
  directory: string,
  source: SourceDescriptor,
  options: LocalIngestionOptions = {},
): AsyncGenerator<ParsedDocument> {
  const root = resolve(directory);
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes <= 0) throw new RangeError("maxFileBytes must be a positive safe integer");

  const extensions = new Set((options.extensions ?? [...DEFAULT_EXTENSIONS]).map((value) => value.toLocaleLowerCase("en-US")));
  for await (const file of walkFiles(root, root, extensions)) {
    const path = toPosixPath(relative(root, file));
    if (options.pathFilter && !options.pathFilter(path)) continue;

    const info = await stat(file);
    if (info.size > maxFileBytes) continue;
    const content = await readFile(file, "utf8");
    const extra = options.metadataForPath?.(path);
    const input: IngestInput = {
      source,
      path,
      content,
      sourceModifiedAt: info.mtime.toISOString(),
      sourceFileHash: extra?.sourceFileHash ?? sha256Text(content),
      ...(extra?.canonicalUrl ? { canonicalUrl: extra.canonicalUrl } : {}),
      ...(extra?.revisionUrl ? { revisionUrl: extra.revisionUrl } : {}),
      ...(extra?.apiVersion ? { apiVersion: extra.apiVersion } : {}),
      ...(extra?.minecraftVersion ? { minecraftVersion: extra.minecraftVersion } : {}),
    };
    yield ingestDocument(input);
  }
}

export async function ingestLocalDirectory(
  directory: string,
  source: SourceDescriptor,
  options: LocalIngestionOptions = {},
): Promise<ParsedDocument[]> {
  const documents: ParsedDocument[] = [];
  for await (const document of walkLocalDocuments(directory, source, options)) documents.push(document);
  return documents;
}
