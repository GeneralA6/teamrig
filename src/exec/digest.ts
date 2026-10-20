import { createHash } from 'node:crypto';
import { isRecord } from '../core/guards.ts';

function byKey([left]: readonly [string, unknown], [right]: readonly [string, unknown]): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * JSON with every object's keys sorted, at every depth, and no spacing: one value always gives one text, whatever order
 * its fields were built in, so a hash of the text binds the value (T755: a request, an approval, an audit line).
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => (isRecord(item) ? Object.fromEntries(Object.entries(item).sort(byKey)) : item));
}

/** The SHA-256 of `text` (UTF-8) as 64 lowercase hex digits. */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
