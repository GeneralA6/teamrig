import { isNonNegativeInteger, stringField } from "../core/guards.js";
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
/** A refresh state file's content; undefined when it is damaged, from another format or names no known phase. */
export function parseRefreshState(text) {
    const record = recordOf(text);
    const task = record === undefined ? undefined : stringField(record, 'task');
    const at = record === undefined ? undefined : stringField(record, 'at');
    if (record === undefined || task === undefined || at === undefined) {
        return undefined;
    }
    switch (record['phase']) {
        case 'boundary': {
            const finished = finishedOf(record, 1);
            return finished === undefined ? undefined : { phase: 'boundary', task, at, finished };
        }
        case 'idle': {
            const tokens = tokensOf(record);
            const finished = finishedOf(record, 0);
            return tokens === undefined || finished === undefined ? undefined : { phase: 'idle', task, at, tokens, finished };
        }
        case 'asked': {
            const tokens = tokensOf(record);
            const handoverHash = hashOf(record);
            return tokens === undefined || handoverHash === undefined ? undefined : { phase: 'asked', task, at, tokens, handoverHash };
        }
        case 'ready': {
            const noticed = record['noticed'];
            return typeof noticed === 'boolean' ? { phase: 'ready', task, at, noticed } : undefined;
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
