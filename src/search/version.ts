export type VersionCompatibility = "exact" | "compatible" | "unknown" | "mismatch";

function normalizeVersion(value: string): string {
  return value.trim().toLocaleLowerCase("en-US").replace(/^v(?=\d)/, "");
}

function numericCore(value: string): string[] | undefined {
  const match = /^(\d+(?:\.\d+){0,3})(?:[-+].*)?$/.exec(value);
  return match?.[1]?.split(".");
}

/**
 * Compare a requested Minecraft/API version with indexed provenance.
 *
 * Full equality is exact. A shorter numeric request (for example `1.21` or
 * `2`) is compatible with a more specific indexed version such as `1.21.80`
 * or `2.9.0`. Missing provenance remains usable as an unknown fallback, while
 * a known incompatible version is rejected.
 */
export function versionCompatibility(
  requested: string | undefined,
  actual: string | undefined,
): VersionCompatibility {
  if (!requested) return "unknown";
  if (!actual) return "unknown";

  const wanted = normalizeVersion(requested);
  const available = normalizeVersion(actual);
  if (wanted === available) return "exact";

  const wantedCore = numericCore(wanted);
  const availableCore = numericCore(available);
  if (wantedCore && availableCore && wantedCore.length < availableCore.length) {
    const prefixMatches = wantedCore.every((segment, index) => availableCore[index] === segment);
    if (prefixMatches) return "compatible";
  }

  return "mismatch";
}

export function versionMatchScore(
  requested: string | undefined,
  actual: string | undefined,
): number {
  if (!requested) return 0;
  switch (versionCompatibility(requested, actual)) {
    case "exact":
      return 30;
    case "compatible":
      return 15;
    case "unknown":
      return -4;
    case "mismatch":
      return -1000;
  }
}
