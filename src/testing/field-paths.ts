import { isRecord } from '../core/guards.ts';

/**
 * Every field path in a written file's JSON value, sorted, for a test that pins the fields of a store's format.
 * An array's entries read as `[]`; the object at a path in `maps` is keyed by data (a day, an hour, a
 * transcript) rather than by field, so its keys read as `*`, the root's too when `maps` holds ''. An empty
 * array or object shows no path, so a pin reads a value with every field set and every list filled.
 */
export function fieldPaths(value: unknown, maps: ReadonlySet<string> = new Set(), path = ''): readonly string[] {
  if (Array.isArray(value)) {
    return [...new Set(value.flatMap((entry: unknown) => fieldPaths(entry, maps, `${path}[]`)))].sort();
  }
  if (!isRecord(value)) {
    return [path];
  }
  return [
    ...new Set(
      Object.entries(value).flatMap(([key, entry]) => {
        const name = maps.has(path) ? '*' : key;
        return fieldPaths(entry, maps, path === '' ? name : `${path}.${name}`);
      }),
    ),
  ].sort();
}
