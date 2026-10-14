import { stringField } from "../core/guards.js";
import { ID_PATTERN, NAME_PATTERN } from "../core/ids.js";
export const RENAME_VERSION = 1;
export function parseRename(line) {
    if (line.version > RENAME_VERSION) {
        return { kind: 'newer' };
    }
    const { record } = line;
    const id = stringField(record, 'id');
    const from = stringField(record, 'from');
    const to = stringField(record, 'to');
    const at = stringField(record, 'at');
    const by = stringField(record, 'by');
    if (id === undefined ||
        !ID_PATTERN.test(id) ||
        from === undefined ||
        !NAME_PATTERN.test(from) ||
        to === undefined ||
        !NAME_PATTERN.test(to) ||
        from === to ||
        at === undefined ||
        Number.isNaN(Date.parse(at)) ||
        by === undefined ||
        !ID_PATTERN.test(by)) {
        return { kind: 'unreadable' };
    }
    return { kind: 'rename', rename: { v: line.version, id, from, to, at, by } };
}
