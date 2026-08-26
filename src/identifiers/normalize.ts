const CAMEL_BOUNDARY = /([a-z0-9])([A-Z])/g;

export function normalizeIdentifier(value: string): string {
  return value.trim().replace(/^`+|`+$/g, "").replace(/\s+/g, "").toLocaleLowerCase("en-US");
}

export function identifierLeaf(value: string): string {
  const clean = value.trim().replace(/^`+|`+$/g, "");
  const segments = clean.split(/[.:/]/).filter(Boolean);
  return segments.at(-1) ?? clean;
}

export function identifierSearchTerms(value: string): string[] {
  const clean = value.trim().replace(/^`+|`+$/g, "");
  if (clean.length === 0) return [];

  const terms = new Set<string>([clean]);
  const leaf = identifierLeaf(clean);
  terms.add(leaf);

  for (const part of clean.split(/[.:/_@-]+/).filter(Boolean)) {
    terms.add(part);
    const spaced = part.replace(CAMEL_BOUNDARY, "$1 $2");
    if (spaced !== part) terms.add(spaced);
  }

  return [...terms];
}
