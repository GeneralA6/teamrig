/** Checked readers for GitHub API bodies: a body of the wrong shape throws, naming what was being read. */

export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The object a body holds; throws when it is a list, a scalar or null. */
export function recordOf(json: string, what: string): Record<string, unknown> {
  const body: unknown = JSON.parse(json);
  if (!isRecord(body)) throw new Error(`${what}: expected an object`);
  return body;
}

/** The objects of a body that is a list. */
export function arrayOf(json: string, what: string): Record<string, unknown>[] {
  const body: unknown = JSON.parse(json);
  if (!Array.isArray(body)) throw new Error(`${what}: expected a list`);
  return body.filter(isRecord);
}

/** The objects of the list a body holds under `key`. */
export function listAt(json: string, key: string, what: string): Record<string, unknown>[] {
  const list = recordOf(json, what)[key];
  if (!Array.isArray(list)) throw new Error(`${what}: expected a "${key}" list`);
  return list.filter(isRecord);
}

export function recordAt(item: Record<string, unknown>, key: string, what: string): Record<string, unknown> {
  const value = item[key];
  if (!isRecord(value)) throw new Error(`${what}: "${key}" is not an object`);
  return value;
}

export function numberAt(item: Record<string, unknown>, key: string, what: string): number {
  const value = item[key];
  if (typeof value !== 'number') throw new Error(`${what}: "${key}" is not a number`);
  return value;
}

export function stringAt(item: Record<string, unknown>, key: string, what: string): string {
  const value = item[key];
  if (typeof value !== 'string') throw new Error(`${what}: "${key}" is not a string`);
  return value;
}

export function booleanAt(item: Record<string, unknown>, key: string, what: string): boolean {
  const value = item[key];
  if (typeof value !== 'boolean') throw new Error(`${what}: "${key}" is not a boolean`);
  return value;
}
