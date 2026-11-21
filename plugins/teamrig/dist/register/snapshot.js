import { parseJsonl } from "../core/jsonl.js";
import { EVENT_VERSION, parseEvent } from "./events.js";
import { foldEvents } from "./fold.js";
import { parseMarker } from "./marker.js";
import { TASK_ID } from "./model.js";
export function readEvents(text) {
    return readEventRecords(parseJsonl(text));
}
/** The events of lines already parsed: `readEvents` of the text they came from. */
export function readEventRecords(parse) {
    const events = [];
    const lines = [];
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
            lines.push(line.raw);
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
    return { events, lines, seenIds, unreadable, newer, newestVersion, rotatedAfter: rotatedAfter ?? 0 };
}
/** True when this code may append: no line is in a format newer than the one it writes. */
export function isWritable(read) {
    return read.newestVersion <= EVENT_VERSION;
}
/**
 * True when the read lacks events from `at` on: its event window (a snapshot of task lines, layout.ts) opens after
 * `at`, so a reader of the events since then reads the history.
 */
export function windowOpensAfter({ window }, at) {
    return window !== null && at < Date.parse(window.from);
}
/**
 * True when the read may lack events of task `id`, so a reader of the task's whole history reads the history: the
 * working set lacks the task and left some to the archive (retired), or the task was created before the event window
 * opened, and its older events are only there.
 */
export function lacksEventsOf(snapshot, id) {
    const task = snapshot.state.tasks.get(id);
    return task === undefined ? snapshot.retired !== null : windowOpensAfter(snapshot, Date.parse(task.createdAt));
}
/** Replays a read log: every task as its events leave it, plus the counts `teamrig list` warns about. */
export function snapshotOf(read) {
    return { state: foldEvents(read.events, read.seenIds), read, retired: null, window: null };
}
/**
 * The register that one log text describes, read the way every teamrig command reads a register that
 * was never rotated. A rotated register (layout.ts) spreads over several files: read it with
 * `readWorkingSet` or `readHistory`.
 */
export function readRegister(text) {
    return snapshotOf(readEvents(text));
}
