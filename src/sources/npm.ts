import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import * as z from "zod/v4";
import { sha256Text } from "../ingestion/hashing.js";
import { walkLocalDocuments } from "../ingestion/local.js";
import type { ParsedDocument } from "../models/document.js";
import type { ReleaseChannel } from "../models/enums.js";
import type { SourceDescriptor, SourceTier } from "../models/source.js";

const NPM_REGISTRY_ORIGIN = "https://registry.npmjs.org";
const MAX_REGISTRY_RESPONSE_BYTES = 16_000_000;
const REQUEST_TIMEOUT_MS = 30_000;
const SNAPSHOT_MANIFEST = ".bedrock-npm-source.json";

const packageNameSchema = z.string().regex(/^@minecraft\/[a-z0-9][a-z0-9._-]{1,100}$/);
const distTagSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,50}$/);
const sourceTierSchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);
const releaseChannelSchema = z.enum(["stable", "preview"]);

const npmSourceRegistrySchema = z.object({
  sources: z.array(z.object({
    id: z.string().regex(/^[a-z0-9][a-z0-9_-]{1,63}$/),
    name: z.string().trim().min(1).max(200),
    tier: sourceTierSchema,
    channel: releaseChannelSchema,
    defaultEnabled: z.boolean().default(true),
    packages: z.array(z.object({
      name: packageNameSchema,
      tags: z.array(distTagSchema).min(1).max(8),
    })).min(1).max(40),
  })).min(1).max(10),
});

const registryVersionSchema = z.object({
  version: z.string().min(1).max(100),
  description: z.string().max(2_000).optional(),
  deprecated: z.string().max(2_000).optional(),
  peerDependencies: z.record(z.string(), z.string()).optional(),
}).passthrough();

const registryMetadataSchema = z.object({
  name: packageNameSchema,
  description: z.string().max(2_000).optional(),
  "dist-tags": z.record(z.string(), z.string()),
  versions: z.record(z.string(), registryVersionSchema),
  time: z.record(z.string(), z.string()).optional(),
}).passthrough();

export interface NpmPackageConfig {
  readonly name: string;
  readonly tags: readonly string[];
}

export interface NpmSourceConfigEntry {
  readonly id: string;
  readonly name: string;
  readonly tier: SourceTier;
  readonly channel: Exclude<ReleaseChannel, "unknown">;
  readonly defaultEnabled: boolean;
  readonly packages: readonly NpmPackageConfig[];
}

export interface NpmSourceRegistry {
  readonly sources: readonly NpmSourceConfigEntry[];
}

export interface NpmSnapshotTag {
  readonly packageName: string;
  readonly tag: string;
  readonly version: string;
  readonly apiVersion: string;
  readonly manifestTrackVersion?: string;
  readonly minecraftVersion?: string;
  readonly canonicalUrl: string;
  readonly path: string;
}

export interface NpmSnapshotManifest {
  readonly sourceId: string;
  readonly revision: string;
  readonly syncedAt: string;
  readonly tags: readonly NpmSnapshotTag[];
}

export interface NpmSyncStats {
  readonly sourceId: string;
  readonly status: "created" | "updated" | "unchanged";
  readonly revision: string;
  readonly packages: number;
  readonly tags: number;
}

export interface SyncNpmSourcesOptions {
  readonly dataDir: string;
  readonly configPath?: string;
  readonly includePreview?: boolean;
  readonly fetchImpl?: typeof fetch;
}

function packageSlug(name: string): string {
  return name.replace(/^@minecraft\//, "");
}

function snapshotPath(name: string, tag: string): string {
  return `metadata/ScriptAPI/minecraft/${packageSlug(name)}/${tag}.md`;
}

export function minecraftVersionFromNpmVersion(version: string): string | undefined {
  return /-(?:beta|rc|internal)\.(\d+\.\d+\.\d+(?:-[A-Za-z]+\.\d+)?)$/i.exec(version)?.[1];
}

export function manifestTrackVersionFromNpmVersion(version: string): string | undefined {
  if (/^\d+\.\d+\.\d+$/.test(version)) return version;
  const match = /^(\d+\.\d+\.\d+)-(beta|rc|internal)(?:\.|$)/i.exec(version);
  return match?.[1] && match[2] ? `${match[1]}-${match[2].toLocaleLowerCase("en-US")}` : undefined;
}

function stableVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(version);
}

function recentVersions(
  metadata: z.infer<typeof registryMetadataSchema>,
  channel: NpmSourceConfigEntry["channel"],
  limit = 12,
): string[] {
  const entries = Object.keys(metadata.versions)
    .filter((version) => channel === "stable" ? stableVersion(version) : !stableVersion(version))
    .map((version) => ({ version, time: Date.parse(metadata.time?.[version] ?? "") || 0 }))
    .sort((a, b) => b.time - a.time || b.version.localeCompare(a.version, "en"));
  return entries.slice(0, limit).map((entry) => entry.version);
}

function manifestDependencySnippet(packageName: string, version: string): string {
  return [
    "```json",
    "{",
    "  \"dependencies\": [",
    "    {",
    `      \"module_name\": \"${packageName}\",`,
    `      \"version\": \"${version}\"`,
    "    }",
    "  ]",
    "}",
    "```",
  ].join("\n");
}

function renderSnapshotDocument(
  source: NpmSourceConfigEntry,
  packageConfig: NpmPackageConfig,
  tag: string,
  metadata: z.infer<typeof registryMetadataSchema>,
): { content: string; snapshot: NpmSnapshotTag } | undefined {
  const version = metadata["dist-tags"][tag];
  if (!version) return undefined;
  const versionMetadata = metadata.versions[version];
  if (!versionMetadata) throw new Error(`NPM_METADATA_INVALID: ${packageConfig.name} tag ${tag} points to missing version ${version}`);

  const minecraftVersion = minecraftVersionFromNpmVersion(version);
  const manifestTrackVersion = manifestTrackVersionFromNpmVersion(version);
  const canonicalUrl = `https://www.npmjs.com/package/${encodeURIComponent(packageConfig.name)}/v/${encodeURIComponent(version)}`;
  const path = snapshotPath(packageConfig.name, tag);
  const peers = Object.entries(versionMetadata.peerDependencies ?? {}).sort(([a], [b]) => a.localeCompare(b, "en"));
  const recent = recentVersions(metadata, source.channel);
  const prerelease = source.channel === "preview" || !stableVersion(version);
  const description = versionMetadata.description ?? metadata.description;

  const lines = [
    "---",
    `title: \"${packageConfig.name} npm ${tag} ${version}\"`,
    `api_version: \"${version}\"`,
    ...(minecraftVersion ? [`minecraft_version: \"${minecraftVersion}\"`] : []),
    "---",
    `# ${packageConfig.name} npm ${tag}`,
    "",
    ...(description ? [description, ""] : []),
    `Official npm registry package: \`${packageConfig.name}\``,
    `Release channel: ${source.channel}`,
    `Registry dist-tag: \`${tag}\``,
    `Exact npm package/type-definition version: \`${version}\``,
    ...(manifestTrackVersion ? [`Script API track version: \`${manifestTrackVersion}\``] : []),
    ...(minecraftVersion ? [`Minecraft Preview build encoded by the npm version: \`${minecraftVersion}\``] : []),
    ...(versionMetadata.deprecated ? [`Deprecated by publisher: ${versionMetadata.deprecated}`] : []),
    "",
  ];

  if (!prerelease && manifestTrackVersion === version) {
    lines.push(
      "## Manifest dependency",
      "",
      "For this stable Script API module version, use the exact module version in the behavior-pack manifest dependency:",
      "",
      manifestDependencySnippet(packageConfig.name, version),
      "",
    );
  } else {
    lines.push(
      "## Preview / prerelease version note",
      "",
      "This is prerelease npm metadata. The exact npm version identifies the TypeScript declarations for a particular Preview build. Do not automatically substitute the full npm build suffix into manifest.json unless the official module documentation or a matching official sample uses that exact manifest version. Beta APIs are not backwards-compatible across releases.",
      "",
    );
  }

  if (peers.length > 0) {
    lines.push("## Peer dependencies", "");
    for (const [name, range] of peers) lines.push(`- \`${name}\`: \`${range}\``);
    lines.push("");
  }

  if (recent.length > 0) {
    lines.push(`## Recent ${source.channel} package versions`, "");
    for (const recentVersion of recent) lines.push(`- \`${recentVersion}\``);
    lines.push("");
  }

  return {
    content: lines.join("\n"),
    snapshot: {
      packageName: packageConfig.name,
      tag,
      version,
      apiVersion: version,
      ...(manifestTrackVersion ? { manifestTrackVersion } : {}),
      ...(minecraftVersion ? { minecraftVersion } : {}),
      canonicalUrl,
      path,
    },
  };
}

async function boundedText(response: Response): Promise<string> {
  if (!response.ok) throw new Error(`NPM_REGISTRY_HTTP_${response.status}: registry request failed`);
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_REGISTRY_RESPONSE_BYTES) {
    throw new Error(`NPM_REGISTRY_RESPONSE_TOO_LARGE: ${declared} bytes`);
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    bytes += item.value.byteLength;
    if (bytes > MAX_REGISTRY_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error(`NPM_REGISTRY_RESPONSE_TOO_LARGE: exceeded ${MAX_REGISTRY_RESPONSE_BYTES} bytes`);
    }
    chunks.push(item.value);
  }
  const combined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

async function fetchPackageMetadata(packageName: string, fetchImpl: typeof fetch): Promise<z.infer<typeof registryMetadataSchema>> {
  const url = `${NPM_REGISTRY_ORIGIN}/${encodeURIComponent(packageName)}`;
  const response = await fetchImpl(url, {
    headers: { accept: "application/vnd.npm.install-v1+json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    redirect: "error",
  });
  const parsed = JSON.parse(await boundedText(response)) as unknown;
  const metadata = registryMetadataSchema.parse(parsed);
  if (metadata.name !== packageName) throw new Error(`NPM_PACKAGE_MISMATCH: expected ${packageName}, received ${metadata.name}`);
  return metadata;
}

export async function loadNpmSourceRegistry(path = "config/npm-sources.json"): Promise<NpmSourceRegistry> {
  const raw = JSON.parse(await readFile(resolve(path), "utf8")) as unknown;
  const parsed = npmSourceRegistrySchema.parse(raw);
  const ids = new Set<string>();
  for (const source of parsed.sources) {
    if (ids.has(source.id)) throw new Error(`Duplicate npm source id: ${source.id}`);
    ids.add(source.id);
  }
  return { sources: parsed.sources };
}

export function selectNpmSources(sources: readonly NpmSourceConfigEntry[], includePreview: boolean): NpmSourceConfigEntry[] {
  return sources.filter((source) => source.channel === "preview" ? includePreview : source.defaultEnabled);
}

export function npmSnapshotRoot(dataDir: string): string {
  return join(resolve(dataDir), "npm-sources");
}

function sourceDirectory(dataDir: string, sourceId: string): string {
  return join(npmSnapshotRoot(dataDir), sourceId);
}

async function previousRevision(directory: string): Promise<string | undefined> {
  try {
    const raw = JSON.parse(await readFile(join(directory, SNAPSHOT_MANIFEST), "utf8")) as { revision?: unknown };
    return typeof raw.revision === "string" ? raw.revision : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function syncNpmSource(
  dataDir: string,
  source: NpmSourceConfigEntry,
  fetchImpl: typeof fetch,
): Promise<NpmSyncStats> {
  const root = npmSnapshotRoot(dataDir);
  await mkdir(root, { recursive: true });
  const target = sourceDirectory(dataDir, source.id);
  const staging = `${target}.building-${process.pid}-${Date.now()}`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });

  try {
    const tags: NpmSnapshotTag[] = [];
    for (const packageConfig of source.packages) {
      const metadata = await fetchPackageMetadata(packageConfig.name, fetchImpl);
      for (const tag of packageConfig.tags) {
        const rendered = renderSnapshotDocument(source, packageConfig, tag, metadata);
        if (!rendered) continue;
        const absolute = join(staging, rendered.snapshot.path);
        await mkdir(dirname(absolute), { recursive: true });
        await writeFile(absolute, rendered.content, "utf8");
        tags.push(rendered.snapshot);
      }
    }

    if (tags.length === 0) throw new Error(`NPM_SOURCE_EMPTY: ${source.id} resolved no configured dist-tags`);
    tags.sort((a, b) => a.packageName.localeCompare(b.packageName, "en") || a.tag.localeCompare(b.tag, "en"));
    const revision = sha256Text(JSON.stringify({ sourceId: source.id, channel: source.channel, tags }));
    const manifest: NpmSnapshotManifest = {
      sourceId: source.id,
      revision,
      syncedAt: new Date().toISOString(),
      tags,
    };
    await writeFile(join(staging, SNAPSHOT_MANIFEST), JSON.stringify(manifest, null, 2) + "\n", "utf8");

    const before = await previousRevision(target);
    if (before === revision) {
      await rm(staging, { recursive: true, force: true });
      return { sourceId: source.id, status: "unchanged", revision, packages: source.packages.length, tags: tags.length };
    }

    const old = `${target}.old-${process.pid}-${Date.now()}`;
    try {
      await rename(target, old);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await rename(staging, target);
    await rm(old, { recursive: true, force: true });
    return {
      sourceId: source.id,
      status: before ? "updated" : "created",
      revision,
      packages: source.packages.length,
      tags: tags.length,
    };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export async function syncNpmSources(options: SyncNpmSourcesOptions): Promise<NpmSyncStats[]> {
  const registry = await loadNpmSourceRegistry(options.configPath ?? "config/npm-sources.json");
  const selected = selectNpmSources(registry.sources, options.includePreview ?? false);
  const fetchImpl = options.fetchImpl ?? fetch;
  const results: NpmSyncStats[] = [];
  for (const source of selected) results.push(await syncNpmSource(options.dataDir, source, fetchImpl));
  return results;
}

export interface NpmSnapshot {
  readonly config: NpmSourceConfigEntry;
  readonly directory: string;
  readonly manifest: NpmSnapshotManifest;
  readonly source: SourceDescriptor;
}

export async function openNpmSnapshot(dataDir: string, config: NpmSourceConfigEntry): Promise<NpmSnapshot> {
  const directory = sourceDirectory(dataDir, config.id);
  try {
    await access(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`NPM_SNAPSHOT_MISSING: run sync-sources before rebuilding ${config.id}`);
    }
    throw error;
  }
  const manifest = JSON.parse(await readFile(join(directory, SNAPSHOT_MANIFEST), "utf8")) as NpmSnapshotManifest;
  if (manifest.sourceId !== config.id || !/^sha256:[0-9a-f]{64}$/.test(manifest.revision)) {
    throw new Error(`NPM_SNAPSHOT_INVALID: ${config.id} snapshot provenance is invalid`);
  }
  return {
    config,
    directory,
    manifest,
    source: {
      id: config.id,
      name: config.name,
      tier: config.tier,
      channel: config.channel,
      sourceType: "npm",
      revision: manifest.revision,
      baseUrl: NPM_REGISTRY_ORIGIN,
    },
  };
}

export async function* walkNpmSnapshotDocuments(snapshot: NpmSnapshot): AsyncGenerator<ParsedDocument> {
  const byPath = new Map(snapshot.manifest.tags.map((entry) => [entry.path, entry]));
  yield* walkLocalDocuments(snapshot.directory, snapshot.source, {
    pathFilter: (path) => byPath.has(path),
    metadataForPath: (path) => {
      const entry = byPath.get(path);
      if (!entry) return {};
      return {
        canonicalUrl: entry.canonicalUrl,
        apiVersion: entry.apiVersion,
        ...(entry.minecraftVersion ? { minecraftVersion: entry.minecraftVersion } : {}),
      };
    },
  });
}
