import type { ReleaseChannel } from "./enums.js";

export type SourceTier = 1 | 2 | 3 | 4;
export type SourceType = "git" | "npm" | "local";

export interface SourceDescriptor {
  id: string;
  name: string;
  tier: SourceTier;
  channel: ReleaseChannel;
  sourceType?: SourceType;
  repository?: string;
  branch?: string;
  revision?: string;
  baseUrl?: string;
}
