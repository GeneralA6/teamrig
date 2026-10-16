import { join } from 'node:path';
import { stringField } from "../core/guards.js";
import { parseObject, toJsonlLine, VERSION_FIELD } from "../core/jsonl.js";
/** The format of the warning files this code reads and writes; a file in another format reads as nothing shown. */
export const WARN_FORMAT = 1;
function finiteField(record, key) {
    const value = record[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
/** An optional epoch-ms field: absent is undefined, anything but a finite number is damage. */
function optionalTime(record, key) {
    if (!(key in record)) {
        return { ok: true, value: undefined };
    }
    const value = finiteField(record, key);
    return { ok: value !== undefined, value };
}
/** A warning file's content; undefined when it is damaged or from another format. */
export function parseWarnState(text) {
    const record = parseObject(text.trim());
    if (record === undefined || record[VERSION_FIELD] !== WARN_FORMAT) {
        return undefined;
    }
    const day = stringField(record, 'day');
    const level = finiteField(record, 'level');
    const modelLevel = finiteField(record, 'modelLevel');
    const ahead = record['ahead'];
    const leadTold = record['leadTold'];
    const quietFrom = optionalTime(record, 'quietFrom');
    const marks = [optionalTime(record, 'liftAt'), optionalTime(record, 'burstAt'), optionalTime(record, 'modelBurstAt'), optionalTime(record, 'surplusShown')];
    const [liftAt, burstAt, modelBurstAt, surplusShown] = marks;
    if (day === undefined ||
        level === undefined ||
        modelLevel === undefined ||
        typeof ahead !== 'boolean' ||
        typeof leadTold !== 'boolean' ||
        !quietFrom.ok ||
        marks.some((mark) => !mark.ok)) {
        return undefined;
    }
    return {
        day,
        level,
        modelLevel,
        ahead,
        leadTold,
        quietFrom: quietFrom.value,
        liftAt: liftAt.value,
        burstAt: burstAt.value,
        modelBurstAt: modelBurstAt.value,
        surplusShown: surplusShown.value,
    };
}
export function formatWarnState(state) {
    return toJsonlLine({
        [VERSION_FIELD]: WARN_FORMAT,
        day: state.day,
        level: state.level,
        modelLevel: state.modelLevel,
        ahead: state.ahead,
        leadTold: state.leadTold,
        ...(state.quietFrom === undefined ? {} : { quietFrom: state.quietFrom }),
        ...(state.liftAt === undefined ? {} : { liftAt: state.liftAt }),
        ...(state.burstAt === undefined ? {} : { burstAt: state.burstAt }),
        ...(state.modelBurstAt === undefined ? {} : { modelBurstAt: state.modelBurstAt }),
        ...(state.surplusShown === undefined ? {} : { surplusShown: state.surplusShown }),
    });
}
/**
 * What the budget warning already showed each team session, one small file per session (`<id>.json`),
 * written only by that session's own hooks. Ids are session ids, checked by the roster, so they are
 * safe in a path.
 */
export class WarnStore {
    files;
    folder;
    constructor(files, folder) {
        this.files = files;
        this.folder = folder;
    }
    /** What the session was shown; undefined for none yet or a damaged file, which starts it over. */
    async read(id) {
        const text = await this.files.read(this.pathOf(id));
        return text === undefined ? undefined : parseWarnState(text);
    }
    async write(id, state) {
        await this.files.write(this.pathOf(id), formatWarnState(state));
    }
    pathOf(id) {
        return join(this.folder, `${id}.json`);
    }
}
