import { stringField } from "../core/guards.js";
import { parseObject } from "../core/jsonl.js";
/**
 * How much of a transcript's end is read for its kind: its last turn's records and any `continued-in` after them sit
 * there, short of one tool result larger than this, which leaves the session judged as before.
 */
export const KIND_TAIL_BYTES = 1024 * 1024;
const CONTINUED_IN = 'continued-in';
const ENTRYPOINT = '"entrypoint"';
/** The transcript's kind, read from its end; a torn first line of a tail fails to parse and is skipped. */
export function transcriptKindOf(text) {
    const lines = text.split('\n');
    let continuedIn;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index] ?? '';
        // Most records at a transcript's end (titles, modes, snapshots) name neither; only these two are parsed.
        const record = line.includes(ENTRYPOINT) || line.includes(CONTINUED_IN) ? parseObject(line) : undefined;
        if (record === undefined) {
            continue;
        }
        if (record['type'] === CONTINUED_IN) {
            continuedIn ??= stringField(record, 'continuedInSessionId');
            continue;
        }
        if (stringField(record, 'entrypoint') !== undefined) {
            return { background: stringField(record, 'sessionKind') === 'bg', continuedIn };
        }
    }
    return { background: false, continuedIn };
}
