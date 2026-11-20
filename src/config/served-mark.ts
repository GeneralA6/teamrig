import type { JsonRecord } from '../core/guards.ts';

/**
 * The schema keyword that says how `teamrig read` serves a key of the team config: a reader outside the team's
 * sessions (a pane, a connector) gets the setting rows, and a key's own name decides more surely than a look at its
 * value whether that value may leave the machine's own commands.
 */
export const SERVED_MARK = 'x-teamrig-served';

/**
 * `value`: the key is served with its value, each text of it still looked at for a secret's shape.
 * `location`: the value says where a secret is kept (a file's path, a key in that file), so the row is served
 * without it.
 */
export const SERVED_MARKS = ['value', 'location'] as const;
export type ServedMark = (typeof SERVED_MARKS)[number];

/**
 * A key whose path may name a secret or the place of one. Every such key of the schema states its mark, which
 * `served-mark.test.ts` holds the shipped schema to, so a key added later is decided by a person and never by
 * default. The whole path is matched, so a key added under `secretGuard` needs its mark whatever its own name is.
 */
export const SENSITIVE_KEY = /webhook|token|secret|password|credential|apikey|auth/i;

export function isServedMark(value: unknown): value is ServedMark {
  return SERVED_MARKS.some((mark) => mark === value);
}

/** The mark a key's schema node states; undefined for none, and for a value that is no mark. */
export function statedMarkOf(node: JsonRecord): ServedMark | undefined {
  const stated = node[SERVED_MARK];
  return isServedMark(stated) ? stated : undefined;
}

/**
 * How the key at `path` is served. A key with no mark is served with its value, but for one whose path is
 * sensitive: that one is kept as a location, so a schema that lost a mark serves less, never more.
 */
export function servedMarkOf(path: string, node: JsonRecord): ServedMark {
  return statedMarkOf(node) ?? (SENSITIVE_KEY.test(path) ? 'location' : 'value');
}
