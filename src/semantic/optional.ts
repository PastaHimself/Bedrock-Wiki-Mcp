function errorDetail(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, 300);
}

/**
 * Initialize optional semantic retrieval without making it a serving dependency.
 * Lexical retrieval is the availability boundary for this service.
 */
export async function initializeOptionalSemantic<T>(
  enabled: boolean,
  initialize: () => Promise<T>,
  warn: (message: string) => void,
): Promise<T | undefined> {
  if (!enabled) return undefined;
  try {
    return await initialize();
  } catch (error) {
    warn(`Semantic retrieval unavailable; continuing with lexical search only. ${errorDetail(error)}`);
    return undefined;
  }
}
