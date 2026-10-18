import { isNonNegativeInteger, isRecord } from "../core/guards.js";
import { NewerDataError, parseObject, recordVersion, VERSION_FIELD } from "../core/jsonl.js";
/**
 * The skills scorecard's saved state: the per-day counts and where each transcript's read stands, in one JSON file.
 * Each save holds counts and cursors that agree, so when two scans race the last one wins and nothing counts twice.
 */
export const SCORECARD_FORMAT = 1;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const RUN_MODES = ['skill', 'manual'];
export class ScorecardStore {
    path;
    files;
    constructor(files, path) {
        this.files = files;
        this.path = path;
    }
    /**
     * The saved state; undefined when there is none, or it is damaged or in an older format, which a scan treats as a
     * fresh start. Throws NewerDataError when a newer teamrig wrote it, so this one never overwrites it.
     */
    async load() {
        const text = await this.files.read(this.path);
        const record = text === undefined ? undefined : parseObject(text.trim());
        if (record === undefined) {
            return undefined;
        }
        const version = recordVersion(record);
        if (version !== undefined && version > SCORECARD_FORMAT) {
            throw new NewerDataError(this.path, version, SCORECARD_FORMAT);
        }
        return version === SCORECARD_FORMAT ? parseScorecard(record) : undefined;
    }
    async save(state) {
        await this.files.write(this.path, formatScorecard(state));
    }
}
export function formatScorecard(state) {
    return `${JSON.stringify({ [VERSION_FIELD]: SCORECARD_FORMAT, since: state.since, days: state.days, cursors: state.cursors })}\n`;
}
/** The state in a record of the current format; undefined when any part of it is damaged. */
export function parseScorecard(record) {
    const since = record['since'];
    const days = mapFrom(record['days'], (key) => DAY.test(key), (skills) => mapFrom(skills, (key) => key !== '', skillDayFrom));
    const cursors = mapFrom(record['cursors'], (key) => key !== '', cursorFrom);
    return typeof since === 'string' && DAY.test(since) && days !== undefined && cursors !== undefined ? { since, days, cursors } : undefined;
}
function mapFrom(value, keyFits, itemFrom) {
    if (!isRecord(value)) {
        return undefined;
    }
    const map = {};
    for (const [key, item] of Object.entries(value)) {
        const parsed = itemFrom(item);
        if (!keyFits(key) || parsed === undefined) {
            return undefined;
        }
        map[key] = parsed;
    }
    return map;
}
function countOf(value) {
    return isNonNegativeInteger(value) ? value : undefined;
}
function tallyFrom(value) {
    if (!isRecord(value)) {
        return undefined;
    }
    const { runs, calls, failed, refused } = value;
    return isNonNegativeInteger(runs) && isNonNegativeInteger(calls) && isNonNegativeInteger(failed) && isNonNegativeInteger(refused)
        ? { runs, calls, failed, refused }
        : undefined;
}
function skillDayFrom(value) {
    if (!isRecord(value)) {
        return undefined;
    }
    const { loads, edits } = value;
    const skill = tallyFrom(value['skill']);
    const manual = tallyFrom(value['manual']);
    return isNonNegativeInteger(loads) && isNonNegativeInteger(edits) && skill !== undefined && manual !== undefined ? { loads, skill, manual, edits } : undefined;
}
function openRunFrom(value) {
    if (!isRecord(value)) {
        return undefined;
    }
    const { skill, mode, day, calls, failed, refused } = value;
    const runMode = RUN_MODES.find((known) => known === mode);
    return typeof skill === 'string' &&
        skill !== '' &&
        runMode !== undefined &&
        typeof day === 'string' &&
        DAY.test(day) &&
        isNonNegativeInteger(calls) &&
        isNonNegativeInteger(failed) &&
        isNonNegativeInteger(refused)
        ? { skill, mode: runMode, day, calls, failed, refused }
        : undefined;
}
function listFrom(value, itemFrom) {
    if (!Array.isArray(value)) {
        return undefined;
    }
    const items = value;
    const list = [];
    for (const item of items) {
        const parsed = itemFrom(item);
        if (parsed === undefined) {
            return undefined;
        }
        list.push(parsed);
    }
    return list;
}
function cursorFrom(value) {
    if (!isRecord(value)) {
        return undefined;
    }
    const { offset, size, lastAt, calls } = value;
    const lastLoad = mapFrom(value['lastLoad'], (key) => key !== '', countOf);
    const open = listFrom(value['open'], openRunFrom);
    return isNonNegativeInteger(offset) && isNonNegativeInteger(size) && isNonNegativeInteger(lastAt) && isNonNegativeInteger(calls) && lastLoad !== undefined && open !== undefined
        ? { offset, size, lastAt, calls, lastLoad, open }
        : undefined;
}
