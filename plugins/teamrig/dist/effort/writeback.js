import { join } from 'node:path';
import { isEffortLevel } from "../config/types.js";
import { isRecord, numberField, stringField } from "../core/guards.js";
import { parseObject, toJsonlLine, VERSION_FIELD } from "../core/jsonl.js";
import { RUNNING_TAIL_BYTES } from "../refresh/running.js";
import { typedEffortsOf } from "./typed-effort.js";
/** The format of the marks files this code reads and writes; a file in another format reads as none. */
export const WRITEBACK_MARKS_FORMAT = 1;
export function parseWritebackMarks(text) {
    const record = parseObject(text.trim());
    if (record === undefined || record[VERSION_FIELD] !== WRITEBACK_MARKS_FORMAT) {
        return undefined;
    }
    const lastAt = numberField(record, 'lastAt');
    const config = record['config'];
    if (lastAt === undefined || (config !== null && !isEffortLevel(config))) {
        return undefined;
    }
    return { lastAt, uuid: stringField(record, 'uuid'), config };
}
export function formatWritebackMarks(marks) {
    return toJsonlLine({ [VERSION_FIELD]: WRITEBACK_MARKS_FORMAT, lastAt: marks.lastAt, uuid: marks.uuid, config: marks.config });
}
/**
 * Each team session's marks, one small file per session (`<id>.json`), written only by that session's own hooks.
 * Ids are session ids, checked by the roster, so they are safe in a path.
 */
export class WritebackMarksStore {
    files;
    dir;
    constructor(files, dir) {
        this.files = files;
        this.dir = dir;
    }
    /** The session's marks; undefined before its first look, or for a damaged file, which the next save replaces. */
    async read(id) {
        const text = await this.files.read(this.pathOf(id));
        return text === undefined ? undefined : parseWritebackMarks(text);
    }
    save(id, marks) {
        return this.files.write(this.pathOf(id), formatWritebackMarks(marks));
    }
    pathOf(id) {
        return join(this.dir, `${id}.json`);
    }
}
/**
 * The config file's JSON with only the session's `launch` effort set to `level`; every other key, its own launch
 * keys included, stays as it was. The launch entry is made when the session has none.
 */
export function withLaunchEffort(file, id, level) {
    const launch = isRecord(file['launch']) ? file['launch'] : {};
    // By its own keys only, so an id such as `constructor` never reads the object's prototype.
    const own = Object.entries(launch).find(([key]) => key === id)?.[1];
    return { ...file, launch: { ...launch, [id]: { ...(isRecord(own) ? own : {}), effort: level } } };
}
function newestAfter(typed, lastAt) {
    return typed.filter((entry) => entry.at > lastAt).at(-1);
}
function sameMarks(a, b) {
    return a.lastAt === b.lastAt && a.uuid === b.uuid && a.config === b.config;
}
/**
 * Writes the level of the newest `/effort` the user typed in the session back to its `launch` entry, so a restore or
 * a restart opens it at that level (T2441). A turn that runs at the config's level reads no transcript. Typing before
 * the session's first look never applies (an old `/effort` in a resumed transcript), nor typing before the config
 * changed the session's level, which is the newer decision; a typed level the session no longer runs at is taken up
 * without a write. Each typed entry is taken up once, written back or not.
 */
export async function effortWriteback(deps, input) {
    const config = input.config ?? null;
    const marks = await deps.marks.read(input.id);
    if (marks === undefined) {
        await deps.marks.save(input.id, { lastAt: deps.clock.now(), uuid: undefined, config });
        return undefined;
    }
    const lastAt = marks.config === config ? marks.lastAt : Math.max(marks.lastAt, (await deps.configChangedAt()) ?? deps.clock.now());
    const seen = { ...marks, lastAt, config };
    const runsAsConfigured = isEffortLevel(input.running) && input.running === input.config;
    const text = runsAsConfigured || input.transcript === undefined ? undefined : await deps.files.readTail(input.transcript, RUNNING_TAIL_BYTES);
    const typed = text === undefined ? undefined : newestAfter(typedEffortsOf(text, input.claude), lastAt);
    if (typed === undefined) {
        if (!sameMarks(seen, marks)) {
            await deps.marks.save(input.id, seen);
        }
        return undefined;
    }
    const stillRuns = !isEffortLevel(input.running) || input.running === typed.level;
    const written = stillRuns && typed.level !== input.config ? await deps.write(typed.level) : undefined;
    await deps.marks.save(input.id, { lastAt: typed.at, uuid: typed.uuid, config: written === undefined ? config : written.to });
    return written === undefined ? undefined : { typed, written };
}
/** A write-back's line in the effort change log. */
export function effortChangeLine(at, id, claude, change) {
    const { typed, written } = change;
    return toJsonlLine({
        [VERSION_FIELD]: 1,
        at: new Date(at).toISOString(),
        session: id,
        from: written.from ?? null,
        to: written.to,
        claude,
        uuid: typed.uuid,
        typedAt: new Date(typed.at).toISOString(),
        backup: written.backup,
    });
}
/** The inbox line that tells the session's leader of a write-back. */
export function effortChangeText(name, team, change, zone) {
    const { typed, written } = change;
    return `${name} effort ${written.from ?? 'unset'} -> ${written.to} (a typed /effort at ${zone.clock(new Date(typed.at))}), written to its launch entry in the ${team} config`;
}
