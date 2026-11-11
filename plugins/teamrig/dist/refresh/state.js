import { isNonNegativeInteger, isRecord, stringField } from "../core/guards.js";
import { parseObject, toJsonlLine, VERSION_FIELD } from "../core/jsonl.js";
/** The format of the refresh files this code reads and writes; a file in another format reads as absent. */
export const REFRESH_FORMAT = 1;
/** A file of this format as an object; undefined for a damaged file or one in another format. */
function recordOf(text) {
    const record = parseObject(text.trim());
    return record !== undefined && record[VERSION_FIELD] === REFRESH_FORMAT ? record : undefined;
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
    return task === undefined || at === undefined || tokens === undefined || handoverHash === undefined ? undefined : { task, at, tokens, handoverHash };
}
/** A refresh state file's content; undefined when it is damaged, from another format or names no known phase. */
export function parseRefreshState(text) {
    const record = recordOf(text);
    // Only a task end names its task: a refresh another turn end asked for has none.
    const task = record === undefined ? undefined : nullableString(record, 'task');
    const at = record === undefined ? undefined : stringField(record, 'at');
    if (record === undefined || task === undefined || at === undefined) {
        return undefined;
    }
    switch (record['phase']) {
        case 'boundary': {
            const finished = finishedOf(record, 1);
            // A file from before an ask could stand on a boundary has none.
            const ask = record['ask'] === undefined ? null : standingAskOf(record['ask']);
            return task === null || finished === undefined || ask === undefined ? undefined : { phase: 'boundary', task, at, finished, ask };
        }
        case 'idle': {
            const tokens = tokensOf(record);
            const finished = finishedOf(record, 0);
            return task === null || tokens === undefined || finished === undefined ? undefined : { phase: 'idle', task, at, tokens, finished };
        }
        case 'asked': {
            const tokens = tokensOf(record);
            const handoverHash = hashOf(record);
            // A file from before the mod asked within a turn was always the Stop hook's.
            const midTurn = record['midTurn'] ?? false;
            return tokens === undefined || handoverHash === undefined || typeof midTurn !== 'boolean'
                ? undefined
                : { phase: 'asked', task, at, tokens, handoverHash, midTurn };
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
            return { phase: 'refreshed', task, at };
        default:
            return undefined;
    }
}
export function formatRefreshState(state) {
    return toJsonlLine({ [VERSION_FIELD]: REFRESH_FORMAT, ...state });
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
    if (claudeSession === undefined || transcript === undefined || cwd === undefined || typeof supervised !== 'boolean') {
        return undefined;
    }
    return { claudeSession, transcript, cwd, supervised };
}
