function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

function escapeRegex(character: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(character) ? `\\${character}` : character;
}

export function globToRegExp(glob: string): RegExp {
  const pattern = normalizePath(glob);
  let regex = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] ?? "";
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        while (pattern[index + 1] === "*") index += 1;
        regex += ".*";
      } else {
        regex += "[^/]*";
      }
      continue;
    }
    if (character === "?") {
      regex += "[^/]";
      continue;
    }
    regex += escapeRegex(character);
  }
  regex += "$";
  return new RegExp(regex);
}

export function pathMatchesGlob(path: string, glob: string): boolean {
  return globToRegExp(glob).test(normalizePath(path));
}

export function createSourcePathFilter(
  include: readonly string[] | undefined,
  exclude: readonly string[] | undefined,
): (path: string) => boolean {
  const includePatterns = (include ?? []).map(globToRegExp);
  const excludePatterns = (exclude ?? []).map(globToRegExp);
  return (path: string): boolean => {
    const normalized = normalizePath(path);
    if (includePatterns.length > 0 && !includePatterns.some((pattern) => pattern.test(normalized))) return false;
    return !excludePatterns.some((pattern) => pattern.test(normalized));
  };
}
