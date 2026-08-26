import type { ReleaseChannel } from "./enums.js";

export type SourceTier = 1 | 2 | 3 | 4;

export interface SourceDescriptor {
  id: string;
  name: string;
  tier: SourceTier;
  channel: ReleaseChannel;
  repository?: string;
  branch?: string;
  baseUrl?: string;
}
