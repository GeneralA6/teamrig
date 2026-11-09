/**
 * Each item once: the first of those that share a key, in their order. A guard that weighs every reading of a tool
 * call (core/bash-tool-readings.ts) finds the same call in each, and names or vets it once.
 */
export function uniqueBy<T>(items: readonly T[], keyOf: (item: T) => string): T[] {
  const kept = new Map<string, T>();
  for (const item of items) {
    const key = keyOf(item);
    if (!kept.has(key)) {
      kept.set(key, item);
    }
  }
  return [...kept.values()];
}
