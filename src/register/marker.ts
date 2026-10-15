import { isNonNegativeInteger, type JsonRecord } from '../core/guards.ts';
import type { JsonlRecord } from '../core/jsonl.ts';

/**
 * The format version of the register's layout records: the rotation marker that starts a rotated
 * `events.jsonl` and the header of `snapshot.jsonl`. It is above every event version a teamrig without
 * rotation knew (2), so such a teamrig reads a rotated log's marker as a line from a newer teamrig:
 * it warns and refuses to write instead of appending to a log it would misread.
 */
export const LAYOUT_VERSION = 3;

/** The `type` of the line a rotation writes first in the new `events.jsonl`. */
export const ROTATED_TYPE = 'rotated';

/** What one parsed line is to the reader of a rotated log. */
export type MarkerParse =
  /** An event line (or something else): not a layout record. */
  | { readonly kind: 'none' }
  /** The log goes on from archive segment `after`: segments 1..after hold every earlier line. */
  | { readonly kind: 'marker'; readonly after: number }
  /** A marker in a layout newer than this code: counted with the newer lines, it blocks writes. */
  | { readonly kind: 'newer' }
  | { readonly kind: 'unreadable' };

/** Reads a line as a rotation marker; lines of any other type are not markers. */
export function parseMarker(line: JsonlRecord): MarkerParse {
  if (line.record['type'] !== ROTATED_TYPE || line.version < LAYOUT_VERSION) {
    return { kind: 'none' };
  }
  if (line.version > LAYOUT_VERSION) {
    return { kind: 'newer' };
  }
  const after = line.record['after'];
  return isNonNegativeInteger(after) ? { kind: 'marker', after } : { kind: 'unreadable' };
}

/** The marker record a rotation writes as the new `events.jsonl`'s first line. */
export function markerRecord(after: number, at: string): JsonRecord {
  return { v: LAYOUT_VERSION, type: ROTATED_TYPE, after, at };
}
