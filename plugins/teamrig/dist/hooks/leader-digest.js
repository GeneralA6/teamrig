import { join } from 'node:path';
import { clipEnd } from "../core/clip.js";
import { isNonNegativeInteger, stringField } from "../core/guards.js";
import { KIT_NAME } from "../core/home.js";
import { parseObject, toJsonlLine, VERSION_FIELD } from "../core/jsonl.js";
import { foldEvents } from "../register/fold.js";
/**
 * The leader digest: what a leader's prompt hook shows of the register changes in its tree since its last prompt, so a
 * note that lands only in the register (a `set` or `update` that told no leader) still reaches
 * the leader, at its next prompt and never by a wake. One line per task, the newest change first, at most
 * {@link DIGEST_MAX_LINES} of them; each change shows once, as a cursor per leader keeps how far the digest has read.
 * It reads the leader's own register alone, and only the tasks of its own group, so a task of another team or of another
 * sub-lead's group never shows; teamrig marks no task private, and a note matching a secret shape is withheld.
 */
/** At most this many task lines; the rest are counted on one closing line. */
export const DIGEST_MAX_LINES = 10;
/** A line's note is cut to this many characters, `...` included. */
export const DIGEST_NOTE_CHARS = 80;
/** What a line says in place of a note or title that matches a secret shape. */
export const WITHHELD_NOTE = '(note withheld: it matches a secret shape)';
const timeOf = (at) => Date.parse(at);
/** The cursor once `events` are read: at the newest one, counting every event written at its instant; undefined for none. */
export function cursorAfter(events) {
    let newest;
    let seen = 0;
    for (const event of events) {
        const at = timeOf(event.at);
        if (newest === undefined || at > timeOf(newest)) {
            newest = event.at;
            seen = 1;
        }
        else if (at === timeOf(newest)) {
            seen += 1;
        }
    }
    return newest === undefined ? undefined : { at: newest, seen };
}
/** Whether each event, in log order, comes after the cursor: written later, or at its instant past the `seen` it read. */
function afterCursor(events, cursor) {
    const since = timeOf(cursor.at);
    let atInstant = 0;
    return events.map((event) => {
        const at = timeOf(event.at);
        if (at !== since) {
            return at > since;
        }
        atInstant += 1;
        return atInstant > cursor.seen;
    });
}
function noteOf(event) {
    if (event.type !== 'status' && event.type !== 'update') {
        return undefined;
    }
    const note = event.note?.replace(/\s+/g, ' ').trim() ?? '';
    return note === '' ? undefined : note;
}
function changesOf(input) {
    const fresh = afterCursor(input.events, input.since);
    const atCursor = foldEvents(input.events.filter((_, index) => fresh[index] !== true)).tasks;
    const byTask = new Map();
    input.events.forEach((event, index) => {
        if (fresh[index] === true) {
            byTask.set(event.id, [...(byTask.get(event.id) ?? []), event]);
        }
    });
    return [...byTask].flatMap(([id, events]) => {
        const task = input.tasks.get(id);
        const others = events.filter((event) => event.by !== input.leader);
        if (task === undefined || !input.tree.has(task.owner) || others.length === 0) {
            return [];
        }
        const before = atCursor.get(id)?.status;
        const text = others.map(noteOf).findLast((written) => written !== undefined) ?? (before === undefined ? task.title.replace(/\s+/g, ' ').trim() : undefined);
        const note = text !== undefined && input.isSecret(text) ? WITHHELD_NOTE : text;
        return [{ id, before, after: task.status, note, at: Math.max(...events.map((event) => timeOf(event.at))) }];
    });
}
function lineOf(change) {
    const status = change.before === undefined ? `new -> ${change.after}` : change.before === change.after ? change.after : `${change.before} -> ${change.after}`;
    const note = change.note === undefined ? '' : `: ${change.note === WITHHELD_NOTE ? WITHHELD_NOTE : clipEnd(change.note, DIGEST_NOTE_CHARS)}`;
    return `- ${change.id} ${status}${note}`;
}
/**
 * The digest's lines: a heading, one line per task of the leader's tree that another session changed since the cursor
 * (`T12 open -> in-progress: <note>`, `T15 new -> open: <title>`, `T14 waiting: <note>`), the newest first, and past
 * {@link DIGEST_MAX_LINES} one `...(+N more: teamrig list)` line. Empty when nothing changed.
 */
export function digestLines(input) {
    const changes = changesOf(input).sort((a, b) => b.at - a.at);
    if (changes.length === 0) {
        return [];
    }
    const shown = changes.slice(0, DIGEST_MAX_LINES).map(lineOf);
    const more = changes.length - shown.length;
    const count = `${changes.length} ${changes.length === 1 ? 'task' : 'tasks'}`;
    return [`${KIT_NAME}: register changes in your tree since your last prompt (${count}):`, ...shown, ...(more > 0 ? [`...(+${more} more: ${KIT_NAME} list)`] : [])];
}
/** The format of the cursor files this code reads and writes; a file in another format reads as no cursor. */
export const DIGEST_CURSOR_FORMAT = 1;
/** A cursor file's cursor; undefined when it is damaged or from another format. */
export function parseDigestCursor(text) {
    const record = parseObject(text.trim());
    if (record === undefined || record[VERSION_FIELD] !== DIGEST_CURSOR_FORMAT) {
        return undefined;
    }
    const at = stringField(record, 'at');
    const seen = record['seen'];
    return at === undefined || Number.isNaN(timeOf(at)) || !isNonNegativeInteger(seen) ? undefined : { at, seen };
}
export function formatDigestCursor(cursor) {
    return toJsonlLine({ [VERSION_FIELD]: DIGEST_CURSOR_FORMAT, at: cursor.at, seen: cursor.seen });
}
/**
 * How far each leader's digest has read the register, one small file per leader (`<id>.json`) holding its
 * {@link DigestCursor}, written only by that leader's own prompt hook. Keyed by the team session, not the Claude
 * Code session, so a /clear or a restart carries on from it. Ids are session ids, checked by the roster, so they are
 * safe in a path.
 */
export class DigestCursorStore {
    files;
    folder;
    constructor(files, folder) {
        this.files = files;
        this.folder = folder;
    }
    /** The leader's cursor; undefined for none yet or a damaged file, which starts it over. */
    async read(id) {
        const text = await this.files.read(this.pathOf(id));
        return text === undefined ? undefined : parseDigestCursor(text);
    }
    async write(id, cursor) {
        await this.files.write(this.pathOf(id), formatDigestCursor(cursor));
    }
    pathOf(id) {
        return join(this.folder, `${id}.json`);
    }
}
