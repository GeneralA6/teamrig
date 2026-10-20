import { isStringArray, stringField } from "../core/guards.js";
import { parseObject, toJsonlLine, VERSION_FIELD } from "../core/jsonl.js";
/**
 * The last batch of the owner's decisions the lead asked (`decisions asked`), kept in `decisions-asked.json`:
 * when, by whom, and the tasks it held. Each batch replaces the one before; the decisions themselves are notes on
 * the tasks.
 */
export const ASKED_FORMAT = 1;
export function parseAskedBatch(text) {
    const record = parseObject(text.trim());
    if (record === undefined || record[VERSION_FIELD] !== ASKED_FORMAT) {
        return undefined;
    }
    const askedAt = stringField(record, 'askedAt');
    const by = stringField(record, 'by');
    const ids = record['ids'];
    if (askedAt === undefined || by === undefined || Number.isNaN(Date.parse(askedAt)) || !isStringArray(ids)) {
        return undefined;
    }
    return { askedAt, by, ids };
}
export function formatAskedBatch(batch) {
    return toJsonlLine({ [VERSION_FIELD]: ASKED_FORMAT, askedAt: batch.askedAt, by: batch.by, ids: batch.ids });
}
export class AskedStore {
    files;
    path;
    constructor(files, path) {
        this.files = files;
        this.path = path;
    }
    /** The last batch asked; undefined when none was or the file is damaged, which counts every wait unasked. */
    async read() {
        const text = await this.files.read(this.path);
        return text === undefined ? undefined : parseAskedBatch(text);
    }
    async write(batch) {
        await this.files.write(this.path, formatAskedBatch(batch));
    }
}
/**
 * When the lead last asked the owner a batch: the later of the last `decisions asked` and the last meeting's start
 * (its agenda reads every wait on the owner); undefined when neither happened.
 */
export function askedAtOf(batch, meeting) {
    const times = [batch?.askedAt, meeting?.startedAt].filter((at) => at !== undefined).map((at) => Date.parse(at));
    return times.length === 0 ? undefined : Math.max(...times);
}
