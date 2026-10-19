import { stringField } from "../core/guards.js";
import { recordVersion, toJsonlLine, VERSION_FIELD } from "../core/jsonl.js";
/** The format version of a turn log line. */
export const TURN_LOG_VERSION = 1;
/** The most text one entry keeps: a longer reply keeps its end, where the turn's answer is. */
export const MAX_TEXT_CHARS = 64_000;
const KINDS = new Set(['prompt', 'reply', 'clear']);
function isKind(value) {
    return value !== undefined && KINDS.has(value);
}
/** `text` cut to its last MAX_TEXT_CHARS, with whether it was cut. */
export function cappedText(text) {
    return text.length > MAX_TEXT_CHARS ? { text: text.slice(-MAX_TEXT_CHARS), cut: true } : { text, cut: false };
}
/** The entry as one JSONL line, versioned. */
export function formatEntry(entry) {
    return toJsonlLine({ [VERSION_FIELD]: TURN_LOG_VERSION, ...entry });
}
/** A parsed line as an entry; undefined for a line of a newer version or one missing a field. */
export function parseEntry(record) {
    if (recordVersion(record) !== TURN_LOG_VERSION) {
        return undefined;
    }
    const at = stringField(record, 'at');
    const kind = stringField(record, 'kind');
    const text = stringField(record, 'text');
    const claude = stringField(record, 'claude');
    if (at === undefined || !isKind(kind) || text === undefined || claude === undefined) {
        return undefined;
    }
    const upTo = stringField(record, 'upTo');
    return {
        at,
        kind,
        text,
        claude,
        ...(record['truncated'] === true ? { truncated: true } : {}),
        ...(upTo === undefined ? {} : { upTo }),
    };
}
