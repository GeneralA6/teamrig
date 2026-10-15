import { parseJsonl } from "../core/jsonl.js";
import { EVENT_VERSION, parseEvent } from "./events.js";
import { foldEvents } from "./fold.js";
import { TASK_ID } from "./model.js";
export function readEvents(text) {
    const parse = parseJsonl(text);
    const events = [];
    const seenIds = [];
    let unreadable = parse.unreadable;
    let newer = 0;
    for (const line of parse.records) {
        const result = parseEvent(line);
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
    const newestVersion = parse.records.reduce((max, line) => Math.max(max, line.version), 0);
    return { events, seenIds, unreadable, newer, newestVersion };
}
/** True when this code may append: no line is in a format newer than the one it writes. */
export function isWritable(read) {
    return read.newestVersion <= EVENT_VERSION;
}
/** Replays a read log: every task as its events leave it, plus the counts `teamrig list` warns about. */
export function snapshotOf(read) {
    return { state: foldEvents(read.events, read.seenIds), read };
}
/** The register that an `events.jsonl` text describes, read the way every teamrig command reads it. */
export function readRegister(text) {
    return snapshotOf(readEvents(text));
}
