const WORD = /[\p{L}\p{N}_@.$:-]+/gu;

export interface EvidenceIdentity {
  text: string;
  identifier?: string;
  apiVersion?: string;
  minecraftVersion?: string;
  channel?: string;
}

function normalizedWords(text: string): string[] {
  return (text.toLocaleLowerCase("en-US").match(WORD) ?? []).filter((word) => word.length > 1);
}

function shingles(text: string): Set<string> {
  const words = normalizedWords(text);
  if (words.length < 3) return new Set(words);
  const values = new Set<string>();
  for (let index = 0; index <= words.length - 3; index += 1) {
    values.add(`${words[index]} ${words[index + 1]} ${words[index + 2]}`);
  }
  return values;
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  const smaller = left.size <= right.size ? left : right;
  const larger = left.size <= right.size ? right : left;
  for (const value of smaller) if (larger.has(value)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

function comparable(left: EvidenceIdentity, right: EvidenceIdentity): boolean {
  if (left.channel && right.channel && left.channel !== right.channel) return false;
  if (left.apiVersion && right.apiVersion && left.apiVersion !== right.apiVersion) return false;
  if (left.minecraftVersion && right.minecraftVersion && left.minecraftVersion !== right.minecraftVersion) return false;
  if (left.identifier && right.identifier && left.identifier.toLocaleLowerCase("en-US") !== right.identifier.toLocaleLowerCase("en-US")) return false;
  return true;
}

export function evidenceSimilarity(left: EvidenceIdentity, right: EvidenceIdentity): number {
  if (!comparable(left, right)) return 0;
  const leftWords = normalizedWords(left.text);
  const rightWords = normalizedWords(right.text);
  if (leftWords.length === 0 || rightWords.length === 0) return 0;
  if (leftWords.join(" ") === rightWords.join(" ")) return 1;
  if (Math.min(leftWords.length, rightWords.length) < 12) return 0;
  const ratio = Math.min(leftWords.length, rightWords.length) / Math.max(leftWords.length, rightWords.length);
  if (ratio < 0.8) return 0;
  return jaccard(shingles(left.text), shingles(right.text));
}

export function isNearDuplicateEvidence(left: EvidenceIdentity, right: EvidenceIdentity, threshold = 0.9): boolean {
  return evidenceSimilarity(left, right) >= threshold;
}
