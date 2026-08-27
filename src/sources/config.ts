import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod/v4";
import type { ReleaseChannel } from "../models/enums.js";
import type { SourceDescriptor, SourceTier } from "../models/source.js";

const sourceTierSchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);
const releaseChannelSchema = z.enum(["stable", "preview", "unknown"]);

const sourceConfigEntrySchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{1,63}$/),
  name: z.string().trim().min(1).max(200),
  type: z.literal("git"),
  tier: sourceTierSchema,
  repository: z.string().url(),
  branch: z.string().trim().min(1).max(200),
  channel: releaseChannelSchema,
  include: z.array(z.string().trim().min(1).max(500)).max(100).optional(),
  exclude: z.array(z.string().trim().min(1).max(500)).max(100).optional(),
  defaultEnabled: z.boolean().default(true),
});

const sourceRegistrySchema = z.object({
  sources: z.array(sourceConfigEntrySchema).min(1).max(100),
});

export interface SourceConfigEntry {
  readonly id: string;
  readonly name: string;
  readonly type: "git";
  readonly tier: SourceTier;
  readonly repository: string;
  readonly branch: string;
  readonly channel: ReleaseChannel;
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  readonly defaultEnabled: boolean;
}

export interface SourceRegistry {
  readonly sources: readonly SourceConfigEntry[];
}

export async function loadSourceRegistry(path = "config/sources.json"): Promise<SourceRegistry> {
  const absolutePath = resolve(path);
  const raw = JSON.parse(await readFile(absolutePath, "utf8")) as unknown;
  const parsed = sourceRegistrySchema.parse(raw);
  const ids = new Set<string>();
  const sources: SourceConfigEntry[] = [];
  for (const source of parsed.sources) {
    if (ids.has(source.id)) throw new Error(`Duplicate source id: ${source.id}`);
    ids.add(source.id);
    sources.push({
      id: source.id,
      name: source.name,
      type: source.type,
      tier: source.tier,
      repository: source.repository,
      branch: source.branch,
      channel: source.channel,
      defaultEnabled: source.defaultEnabled,
      ...(source.include !== undefined ? { include: source.include } : {}),
      ...(source.exclude !== undefined ? { exclude: source.exclude } : {}),
    });
  }
  return { sources };
}

export function sourceDescriptor(config: SourceConfigEntry, revision?: string): SourceDescriptor {
  return {
    id: config.id,
    name: config.name,
    tier: config.tier,
    channel: config.channel,
    repository: config.repository,
    branch: config.branch,
    ...(revision ? { revision } : {}),
  };
}
