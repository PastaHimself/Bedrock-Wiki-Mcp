const PREVIEW = /\b(?:beta|preview|experimental|prerelease|pre-release)\b/i;
const STABLE = /\b(?:stable|production|release\s+channel)\b/i;
const VERSION = /\b(?:current|latest|version|versions|compatible|compatibility|supports?|introduced|available|contains?)\b/i;
const MANIFEST = /\b(?:manifest(?:\.json)?|dependencies|dependency|module_name|min_engine_version)\b/i;
const EXAMPLE = /\b(?:example|examples|sample|samples|tutorial|how\s+(?:do|can|should)|show\s+me|code\s+example)\b/i;
const DEFINITION = /\b(?:what\s+is|definition|reference|signature|type\s+of)\b/i;
const DEBUGGING = /\b(?:why|error|errors|fail|fails|failed|invalid|debug|debugging|schema|validate|validation)\b/i;
const MODULE = /@minecraft\/[a-z0-9][a-z0-9._-]*/i;
const IDENTIFIER_LIKE = /(?:minecraft:|@minecraft\/|\b(?:query|variable|context|temp)\.[A-Za-z_$]|[._][A-Za-z_$]|[A-Z][a-z]+[A-Z]|\b[A-Za-z_$]+\.[A-Za-z_$]+)/;

export interface BedrockQueryIntent {
  preview: boolean;
  stable: boolean;
  version: boolean;
  manifest: boolean;
  example: boolean;
  definition: boolean;
  debugging: boolean;
  identifierLike: boolean;
  module?: string;
}

export function detectBedrockQueryIntent(query: string): BedrockQueryIntent {
  const module = MODULE.exec(query)?.[0]?.toLocaleLowerCase("en-US");
  const preview = PREVIEW.test(query);
  return {
    preview,
    // A comparison such as "stable vs beta" needs both channels. Preview intent
    // therefore takes precedence over the stable-only preference.
    stable: STABLE.test(query) && !preview,
    version: VERSION.test(query) || Boolean(module && /\b(?:current|latest|beta|stable)\b/i.test(query)),
    manifest: MANIFEST.test(query),
    example: EXAMPLE.test(query),
    definition: DEFINITION.test(query),
    debugging: DEBUGGING.test(query),
    identifierLike: IDENTIFIER_LIKE.test(query),
    ...(module ? { module } : {}),
  };
}
