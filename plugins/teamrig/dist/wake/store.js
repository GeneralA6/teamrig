import { join } from 'node:path';
import { isRecord, isStringArray, stringField } from "../core/guards.js";
import { parseObject, toJsonlLine, VERSION_FIELD } from "../core/jsonl.js";
import { NO_SETTLED_MOMENTS } from "./decide.js";
/** The format of the wake files this code reads and writes; a file in another format reads as no check yet. */
export const WAKE_FORMAT = 1;
function finiteField(record, key) {
    const value = record[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
/** A stored pending batch: absent is none; damage is undefined, so the whole file reads as damaged. */
function pendingOf(record) {
    const raw = record['pending'];
    if (raw === undefined) {
        return { ok: true, value: undefined };
    }
    const pending = isRecord(raw) ? raw : undefined;
    const since = pending === undefined ? undefined : finiteField(pending, 'since');
    const ids = pending?.['ids'];
    return since !== undefined && isStringArray(ids) ? { ok: true, value: { since, ids } } : { ok: false, value: undefined };
}
/** A stored time that may be absent: absent is undefined; damage is not ok, so the whole file reads as damaged. */
function optionalTimeOf(record, key) {
    if (record[key] === undefined) {
        return { ok: true, value: undefined };
    }
    const value = finiteField(record, key);
    return { ok: value !== undefined, value };
}
/** The stored settled moments: absent (a file from before day starts) is none; damage is not ok. */
function settledOf(record) {
    const raw = record['settled'];
    if (raw === undefined) {
        return { ok: true, value: NO_SETTLED_MOMENTS };
    }
    if (!isRecord(raw)) {
        return { ok: false, value: NO_SETTLED_MOMENTS };
    }
    const dayStart = optionalTimeOf(raw, 'dayStart');
    const burst = optionalTimeOf(raw, 'burst');
    return { ok: dayStart.ok && burst.ok, value: { dayStart: dayStart.value, burst: burst.value } };
}
/** A wake file's content; undefined when it is damaged or from another format, which starts the tab over. */
export function parseWakeState(text) {
    const record = parseObject(text.trim());
    if (record === undefined || record[VERSION_FIELD] !== WAKE_FORMAT) {
        return undefined;
    }
    const tab = stringField(record, 'tab');
    const known = record['known'];
    const pending = pendingOf(record);
    const last = optionalTimeOf(record, 'lastWakeAt');
    const settled = settledOf(record);
    if (tab === undefined || !isStringArray(known) || !pending.ok || !last.ok || !settled.ok) {
        return undefined;
    }
    return { tab, known, pending: pending.value, lastWakeAt: last.value, settled: settled.value };
}
function formatSettled({ dayStart, burst }) {
    return { ...(dayStart === undefined ? {} : { dayStart }), ...(burst === undefined ? {} : { burst }) };
}
export function formatWakeState(state) {
    const settled = formatSettled(state.settled);
    return toJsonlLine({
        [VERSION_FIELD]: WAKE_FORMAT,
        tab: state.tab,
        known: [...state.known],
        ...(state.pending === undefined ? {} : { pending: { since: state.pending.since, ids: [...state.pending.ids] } }),
        ...(state.lastWakeAt === undefined ? {} : { lastWakeAt: state.lastWakeAt }),
        ...(Object.keys(settled).length === 0 ? {} : { settled }),
    });
}
/**
 * What the wake check kept for each team session, one small file per session (`<id>.json`), written under the
 * session's wake lock. Ids are session ids, checked by the roster, so they are safe in a path.
 */
export class WakeStore {
    files;
    folder;
    constructor(files, folder) {
        this.files = files;
        this.folder = folder;
    }
    async read(id) {
        const text = await this.files.read(this.pathOf(id));
        return text === undefined ? undefined : parseWakeState(text);
    }
    async write(id, state) {
        await this.files.write(this.pathOf(id), formatWakeState(state));
    }
    /** The lock held while one tab of the session checks, so two tabs of it never wake it twice. */
    lockOf(id) {
        return join(this.folder, `${id}.lock`);
    }
    pathOf(id) {
        return join(this.folder, `${id}.json`);
    }
}
/** The format of the wake log's lines. */
export const WAKE_LOG_FORMAT = 1;
/** The wake log's line for a record. */
export function formatWakeRecord(record) {
    const base = { [VERSION_FIELD]: WAKE_LOG_FORMAT, at: new Date(record.at).toISOString(), kind: record.kind, session: record.session, tab: record.tab };
    if (record.kind === 'dropped') {
        return toJsonlLine({ ...base, reason: record.reason });
    }
    const { cost } = record;
    return toJsonlLine({
        ...base,
        ids: [...record.ids],
        w: cost.w,
        cold: cost.cold,
        ...(cost.weekPct === undefined ? {} : { weekPct: cost.weekPct }),
        ...(record.asks === undefined ? {} : { asks: record.asks }),
        ...(record.moments === undefined ? {} : { moments: [...record.moments] }),
        ...(record.retry === undefined ? {} : { retry: record.retry }),
    });
}
/** Appends a record to the team's wake log, an append-only file the person reads to see each wake and its cost. */
export async function logWake(files, path, record) {
    await files.append(path, formatWakeRecord(record));
}
