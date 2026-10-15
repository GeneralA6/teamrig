import { join } from 'node:path';
import { isNonNegativeInteger, isRecord, isStringArray } from "../core/guards.js";
import { ID_PATTERN, ID_RULE } from "../core/ids.js";
import { NewerDataError, parseObject, recordVersion, VERSION_FIELD } from "../core/jsonl.js";
import { formatUtcDay, MS_PER_DAY } from "../core/time.js";
import { INITIAL_PATTERN_STATE, parsePatternCounts, parsePatternState } from "./patterns.js";
/** The format of the usage files this code reads and writes; an older or damaged file reads as empty, a newer one is refused. */
export const USAGE_FORMAT = 1;
/** Days of totals a usage file keeps: today and the 7 before it. */
export const DAYS_KEPT = 8;
/**
 * Days a transcript's read position is kept after it last moved: today and yesterday. A transcript
 * read again after its position was dropped starts at today's first line, and nothing of today was
 * counted from it, so dropping it never counts a line twice.
 */
export const CURSOR_DAYS_KEPT = 2;
/** How many recent call keys a usage file keeps to skip a call logged twice. */
export const RECENT_KEYS_KEPT = 200;
export const EMPTY_USAGE = { byDay: {}, cursors: {}, recentKeys: [] };
const DAY = /^\d{4}-\d{2}-\d{2}$/;
function finiteNonNegative(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
function dayUsageFrom(value) {
    if (!isRecord(value)) {
        return undefined;
    }
    const { w, calls } = value;
    const patterns = parsePatternCounts(value['patterns']);
    return finiteNonNegative(w) && isNonNegativeInteger(calls) && patterns !== undefined ? { w, calls, patterns } : undefined;
}
function openCallFrom(value) {
    if (value === null) {
        return null;
    }
    if (!isRecord(value)) {
        return undefined;
    }
    const { key, day, output, context, w } = value;
    if (!(key === null || typeof key === 'string') ||
        typeof day !== 'string' ||
        !DAY.test(day) ||
        !isNonNegativeInteger(output) ||
        !isNonNegativeInteger(context) ||
        !finiteNonNegative(w)) {
        return undefined;
    }
    return { key, day, output, context, w };
}
function cursorFrom(value) {
    if (!isRecord(value)) {
        return undefined;
    }
    const { offset, size, day } = value;
    const call = openCallFrom(value['call']);
    const patterns = parsePatternState(value['patterns']);
    if (!isNonNegativeInteger(offset) || !isNonNegativeInteger(size) || typeof day !== 'string' || !DAY.test(day) || call === undefined || patterns === undefined) {
        return undefined;
    }
    return { offset, size, day, call, patterns };
}
/** Every entry of a stored map through `parse`; undefined when the map or any entry is damaged. */
function mapFrom(value, keyValid, parse) {
    if (!isRecord(value)) {
        return undefined;
    }
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
        const parsed = parse(entry);
        if (!keyValid(key) || parsed === undefined) {
            return undefined;
        }
        out[key] = parsed;
    }
    return out;
}
/**
 * The revision a usage file was written at; 0 for a missing or damaged file, so the first write makes
 * it 1. A file in a newer format is refused, so an old version never replaces what a newer one wrote.
 */
function revOf(path, text) {
    const record = text === undefined ? undefined : parseObject(text.trim());
    const version = record === undefined ? undefined : recordVersion(record);
    if (version !== undefined && version > USAGE_FORMAT) {
        throw new NewerDataError(path, version, USAGE_FORMAT);
    }
    const rev = record?.['rev'];
    return isNonNegativeInteger(rev) ? rev : 0;
}
/** A usage file's content; undefined when it is damaged or in another format, which the meter treats as a fresh start. */
export function parseUsage(text) {
    const record = parseObject(text.trim());
    if (record === undefined || record[VERSION_FIELD] !== USAGE_FORMAT) {
        return undefined;
    }
    const byDay = mapFrom(record['byDay'], (key) => DAY.test(key), dayUsageFrom);
    const cursors = mapFrom(record['cursors'], (key) => key !== '', cursorFrom);
    const recentKeys = record['recentKeys'];
    if (byDay === undefined || cursors === undefined || !isStringArray(recentKeys)) {
        return undefined;
    }
    return { byDay, cursors, recentKeys };
}
export function formatUsage(state, rev) {
    return `${JSON.stringify({ [VERSION_FIELD]: USAGE_FORMAT, rev, byDay: state.byDay, cursors: state.cursors, recentKeys: state.recentKeys })}\n`;
}
/**
 * Drops what a usage file no longer needs at `now`: days older than the kept window, transcript
 * positions that have not moved since before yesterday, and all but the latest call keys.
 */
export function pruneUsage(state, now) {
    const oldestDay = formatUtcDay(new Date(now - (DAYS_KEPT - 1) * MS_PER_DAY));
    const oldestCursor = formatUtcDay(new Date(now - (CURSOR_DAYS_KEPT - 1) * MS_PER_DAY));
    return {
        byDay: Object.fromEntries(Object.entries(state.byDay).filter(([day]) => day >= oldestDay)),
        cursors: Object.fromEntries(Object.entries(state.cursors).filter(([, cursor]) => cursor.day >= oldestCursor)),
        recentKeys: state.recentKeys.slice(-RECENT_KEYS_KEPT),
    };
}
/** A transcript's position before its first read: no call open and no pattern seen. */
export function newCursor(offset, size, day) {
    return { offset, size, day, call: null, patterns: INITIAL_PATTERN_STATE };
}
/**
 * Each session's usage file, `<dir>/<session>.json`. Only the session's own hooks write it, but two of
 * them can run at once: each write replaces the whole file atomically and only when the file still has
 * the revision its writer read, so totals and read positions always change together. A writer that
 * lost writes nothing, and the next run counts its lines again from the positions that won.
 */
export class UsageStore {
    files;
    dir;
    constructor(files, dir) {
        this.files = files;
        this.dir = dir;
    }
    /**
     * The session's usage and its revision: an empty state when there is none or it is damaged.
     * Throws NewerDataError when a newer teamrig wrote it.
     */
    async load(session) {
        const path = this.pathOf(session);
        const text = await this.files.read(path);
        const rev = revOf(path, text);
        const state = text === undefined ? undefined : parseUsage(text);
        return { rev, state: state ?? EMPTY_USAGE };
    }
    /**
     * Writes `state` as the revision after `baseRev`; false, writing nothing, when another writer saved
     * since. Two writers that check at the same moment can both write: the later one replaces the
     * earlier whole, and as each file holds totals that match its own read positions, nothing is
     * counted twice; the lines only the earlier one counted are counted again by the next run.
     */
    async save(session, state, baseRev) {
        const path = this.pathOf(session);
        if (revOf(path, await this.files.read(path)) !== baseRev) {
            return false;
        }
        await this.files.write(path, formatUsage(state, baseRev + 1));
        return true;
    }
    pathOf(session) {
        if (!ID_PATTERN.test(session)) {
            throw new Error(`Session id "${session}" is not valid: ${ID_RULE}.`);
        }
        return join(this.dir, `${session}.json`);
    }
}
