import { parseJsonl } from "../core/jsonl.js";
import { EVENT_VERSION, parseEvent } from "./events.js";
import { foldEvents } from "./fold.js";
import { parseMarker } from "./marker.js";
import { TASK_ID } from "./model.js";
export function readEvents(text) {
    const parse = parseJsonl(text);
    const events = [];
    const seenIds = [];
    let unreadable = parse.unreadable;
    let newer = 0;
    let newestVersion = 0;
    let rotatedAfter;
    for (const line of parse.records) {
        const marker = parseMarker(line);
        if (marker.kind === 'marker') {
            rotatedAfter ??= marker.after;
            continue;
        }
        // A damaged marker is in a layout this code knows: it is counted, and blocks no write.
        if (marker.kind !== 'unreadable') {
            newestVersion = Math.max(newestVersion, line.version);
        }
        const result = marker.kind === 'none' ? parseEvent(line) : marker;
        if (result.kind === 'event') {
            events.push(result.event);
            continue;
        }
        if (result.kind === 'newer') {
            newer += 1;
        }
        else {
            unreadable += 1;
        }
        const id = line.record['id'];
        if (typeof id === 'string' && TASK_ID.test(id)) {
            seenIds.push(id);
        }
    }
    return { events, seenIds, unreadable, newer, newestVersion, rotatedAfter: rotatedAfter ?? 0 };
}
/** True when this code may append: no line is in a format newer than the one it writes. */
export function isWritable(read) {
    return read.newestVersion <= EVENT_VERSION;
}
/** Replays a read log: every task as its events leave it, plus the counts `teamrig list` warns about. */
export function snapshotOf(read) {
    return { state: foldEvents(read.events, read.seenIds), read, retired: null };
}
/**
 * The register that one log text describes, read the way every teamrig command reads a register that
 * was never rotated. A rotated register (layout.ts) spreads over several files: read it with
 * `readWorkingSet` or `readHistory`.
 */
export function readRegister(text) {
    return snapshotOf(readEvents(text));
}
