import { isNonNegativeInteger } from "../core/guards.js";
/**
 * The format version of the register's layout records: the rotation marker that starts a rotated
 * `events.jsonl` and the header of `snapshot.jsonl`. It is above every event version a teamrig without
 * rotation knew (2), so such a teamrig reads a rotated log's marker as a line from a newer teamrig:
 * it warns and refuses to write instead of appending to a log it would misread. This code writes it, and
 * reads every layout from FIRST_LAYOUT_VERSION to NEWEST_LAYOUT_VERSION.
 */
export const LAYOUT_VERSION = 3;
/** The first layout version: the one rotation started with. Every later layout holds the same records. */
export const FIRST_LAYOUT_VERSION = 3;
/**
 * The newest layout this code reads. Layout 4 holds the same records as 3: a writer raises it only so that a
 * teamrig that reads 3 at most counts the files as newer and neither writes nor rotates them (a teamrig that
 * old rotated a register and dropped the event fields it did not parse). Readers take it before a writer writes it.
 */
export const NEWEST_LAYOUT_VERSION = 4;
/** True for a layout version this code reads. */
export function readsLayout(version) {
    return version >= FIRST_LAYOUT_VERSION && version <= NEWEST_LAYOUT_VERSION;
}
/** The `type` of the line a rotation writes first in the new `events.jsonl`. */
export const ROTATED_TYPE = 'rotated';
/** Reads a line as a rotation marker; lines of any other type are not markers. */
export function parseMarker(line) {
    if (line.record['type'] !== ROTATED_TYPE || line.version < FIRST_LAYOUT_VERSION) {
        return { kind: 'none' };
    }
    if (!readsLayout(line.version)) {
        return { kind: 'newer' };
    }
    const after = line.record['after'];
    return isNonNegativeInteger(after) ? { kind: 'marker', after } : { kind: 'unreadable' };
}
/** The marker record a rotation writes as the new `events.jsonl`'s first line. */
export function markerRecord(after, at) {
    return { v: LAYOUT_VERSION, type: ROTATED_TYPE, after, at };
}
