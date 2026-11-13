import { isEffortLevel } from "../config/types.js";
import { isNonNegativeInteger, isRecord, stringField } from "../core/guards.js";
import { parseObject, recordVersion, toJsonlLine, VERSION_FIELD } from "../core/jsonl.js";
/** The format of the refresh files this code reads and writes; a file in another format reads as absent. */
export const REFRESH_FORMAT = 1;
/**
 * The format of the state file (`<id>.json`): 2 adds the `baseline` of a fresh start, 3 the `largeWindow` every phase
 * carries. A format 1 or 2 file reads as it did, with neither field; a file in a newer format reads as absent and is
 * never overwritten (`RefreshStore.setState`).
 */
export const REFRESH_STATE_FORMAT = 3;
/** The format before `largeWindow`, still read. */
const REFRESH_STATE_FORMAT_2 = 2;
/** A file of this format as an object; undefined for a damaged file or one in another format. */
function recordOf(text) {
    const record = parseObject(text.trim());
    return record !== undefined && record[VERSION_FIELD] === REFRESH_FORMAT ? record : undefined;
}
/** A state file's record: format 1 or 2; undefined for a damaged file or another format. */
function stateRecordOf(text) {
    const record = parseObject(text.trim());
    const version = record === undefined ? undefined : recordVersion(record);
    return record !== undefined && (version === REFRESH_FORMAT || version === REFRESH_STATE_FORMAT_2 || version === REFRESH_STATE_FORMAT) ? record : undefined;
}
/** The baseline field as a spread: absent for none, null while a fresh start waits for it; undefined when damaged. */
function baselineOf(record) {
    const baseline = record['baseline'];
    if (baseline === undefined) {
        return {};
    }
    return baseline === null || isNonNegativeInteger(baseline) ? { baseline } : undefined;
}
function tokensOf(record) {
    const tokens = record['tokens'];
    return tokens === null || isNonNegativeInteger(tokens) ? tokens : undefined;
}
/** The task count; a file from before the count has none and reads as `absent`, a wrong value as undefined. */
function finishedOf(record, absent) {
    const finished = record['finished'];
    if (finished === undefined) {
        return absent;
    }
    return isNonNegativeInteger(finished) ? finished : undefined;
}
function hashOf(record) {
    const hash = record['handoverHash'];
    return hash === null || typeof hash === 'string' ? hash : undefined;
}
/** The ask's `fixHash` as fields to spread: none when absent (a file from before it, or no fix asked), false when damaged. */
function fixHashOf(record) {
    const hash = record['fixHash'];
    if (hash === undefined) {
        return {};
    }
    return typeof hash === 'string' ? { fixHash: hash } : false;
}
/** A boundary's standing ask: null for none, undefined when damaged. */
function standingAskOf(value) {
    if (value === null) {
        return null;
    }
    if (!isRecord(value)) {
        return undefined;
    }
    const task = nullableString(value, 'task');
    const at = stringField(value, 'at');
    const tokens = tokensOf(value);
    const handoverHash = hashOf(value);
    const fix = fixHashOf(value);
    return task === undefined || at === undefined || tokens === undefined || handoverHash === undefined || fix === false
        ? undefined
        : { task, at, tokens, handoverHash, ...fix };
}
/** The window field as a spread: absent while nothing told; undefined when damaged. */
function windowFieldOf(record) {
    const largeWindow = record['largeWindow'];
    if (largeWindow === undefined) {
        return {};
    }
    return typeof largeWindow === 'boolean' ? { largeWindow } : undefined;
}
/** A refresh state file's content; undefined when it is damaged, from another format or names no known phase. */
export function parseRefreshState(text) {
    const record = stateRecordOf(text);
    // Only a task end names its task: a refresh another turn end asked for has none.
    const task = record === undefined ? undefined : nullableString(record, 'task');
    const at = record === undefined ? undefined : stringField(record, 'at');
    const base = record === undefined ? undefined : baselineOf(record);
    const window = record === undefined ? undefined : windowFieldOf(record);
    if (record === undefined || task === undefined || at === undefined || base === undefined || window === undefined) {
        return undefined;
    }
    const phase = phaseOf(record, task, at, base);
    return phase === undefined ? undefined : { ...phase, ...window };
}
/** The phase a refresh state file names, its window field aside; undefined when damaged or unknown. */
function phaseOf(record, task, at, base) {
    switch (record['phase']) {
        case 'boundary': {
            const finished = finishedOf(record, 1);
            // A file from before an ask could stand on a boundary has none.
            const ask = record['ask'] === undefined ? null : standingAskOf(record['ask']);
            return task === null || finished === undefined || ask === undefined ? undefined : { phase: 'boundary', task, at, finished, ask, ...base };
        }
        case 'idle': {
            const tokens = tokensOf(record);
            const finished = finishedOf(record, 0);
            return task === null || tokens === undefined || finished === undefined ? undefined : { phase: 'idle', task, at, tokens, finished, ...base };
        }
        case 'asked': {
            const tokens = tokensOf(record);
            const handoverHash = hashOf(record);
            // A file from before the mod asked within a turn was always the Stop hook's.
            const midTurn = record['midTurn'] ?? false;
            const fix = fixHashOf(record);
            return tokens === undefined || handoverHash === undefined || typeof midTurn !== 'boolean' || fix === false
                ? undefined
                : { phase: 'asked', task, at, tokens, handoverHash, midTurn, ...fix };
        }
        case 'ready': {
            const noticed = record['noticed'];
            // A file from before the transcript was recorded has none.
            const transcript = record['transcript'] === undefined ? null : nullableString(record, 'transcript');
            const claudePid = nullablePidOf(record['claudePid']);
            // A file from before the size was recorded has none.
            const tokens = record['tokens'] === undefined ? null : tokensOf(record);
            return typeof noticed === 'boolean' && transcript !== undefined && claudePid !== undefined && tokens !== undefined
                ? { phase: 'ready', task, at, tokens, noticed, transcript, claudePid }
                : undefined;
        }
        case 'refreshed':
            return { phase: 'refreshed', task, at, ...base };
        default:
            return undefined;
    }
}
export function formatRefreshState(state) {
    return toJsonlLine({ [VERSION_FIELD]: REFRESH_STATE_FORMAT, ...state });
}
/** A request file's content; undefined when it is damaged or from another format. */
export function parseRefreshRequest(text) {
    const record = recordOf(text);
    const by = record === undefined ? undefined : stringField(record, 'by');
    const at = record === undefined ? undefined : stringField(record, 'at');
    return by === undefined || at === undefined ? undefined : { by, at };
}
export function formatRefreshRequest(request) {
    return toJsonlLine({ [VERSION_FIELD]: REFRESH_FORMAT, ...request });
}
/** A process id, null when absent or null, undefined when damaged. */
function nullablePidOf(value) {
    if (value === undefined || value === null) {
        return null;
    }
    return isNonNegativeInteger(value) && value > 0 ? value : undefined;
}
function nullableString(record, key) {
    const value = record[key];
    return value === null || typeof value === 'string' ? value : undefined;
}
/** A restart file's content; undefined when it is damaged or from another format. */
export function parseRestartRequest(text) {
    const record = recordOf(text);
    if (record === undefined) {
        return undefined;
    }
    const phase = record['phase'];
    const at = stringField(record, 'at');
    const pid = record['pid'];
    const tab = restartTabOf(record);
    if ((phase !== 'pending' && phase !== 'ending') || at === undefined || !isNonNegativeInteger(pid) || pid === 0 || tab === undefined) {
        return undefined;
    }
    return { phase, at, pid, ...tab };
}
export function formatRestartRequest(request) {
    return toJsonlLine({ [VERSION_FIELD]: REFRESH_FORMAT, ...request });
}
/** A parked restart file's content; undefined when it is damaged or from another format. */
export function parseParkedRestart(text) {
    const record = recordOf(text);
    if (record === undefined) {
        return undefined;
    }
    const at = stringField(record, 'at');
    const tab = restartTabOf(record);
    return at === undefined || tab === undefined ? undefined : { at, ...tab };
}
export function formatParkedRestart(parked) {
    return toJsonlLine({ [VERSION_FIELD]: REFRESH_FORMAT, ...parked });
}
/** The tab fields of a restart file; undefined when one is missing or of the wrong type. */
function restartTabOf(record) {
    const claudeSession = stringField(record, 'claudeSession');
    const transcript = nullableString(record, 'transcript');
    const cwd = nullableString(record, 'cwd');
    const supervised = record['supervised'];
    const effort = effortOf(record['effort']);
    if (claudeSession === undefined || transcript === undefined || cwd === undefined || typeof supervised !== 'boolean' || effort === undefined) {
        return undefined;
    }
    return { claudeSession, transcript, cwd, supervised, effort };
}
/** A recorded effort level, null when absent (a file from before it) or null, undefined when damaged. */
function effortOf(value) {
    if (value === undefined || value === null) {
        return null;
    }
    return isEffortLevel(value) ? value : undefined;
}
