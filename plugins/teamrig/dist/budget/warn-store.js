import { join } from 'node:path';
import { numberField, stringField } from "../core/guards.js";
import { parseObject, toJsonlLine, VERSION_FIELD, writableObject } from "../core/jsonl.js";
/**
 * The format of the warning files this code writes. A file in an older format it knows reads with the fields added
 * since at their defaults; one in any other format reads as nothing shown, and one in a newer format refuses a write.
 */
export const WARN_FORMAT = 2;
/**
 * The format before `escalated` was kept: it reads as not escalated, so a session escalated at the upgrade sees its
 * line once more.
 */
const UNESCALATED_FORMAT = 1;
/** An optional epoch-ms field: absent is undefined, anything but a finite number is damage. */
function optionalTime(record, key) {
    if (!(key in record)) {
        return { ok: true, value: undefined };
    }
    const value = numberField(record, key);
    return { ok: value !== undefined, value };
}
/** A warning file's content; undefined when it is damaged or from a format this code does not read. */
export function parseWarnState(text) {
    const record = parseObject(text.trim());
    const version = record?.[VERSION_FIELD];
    if (record === undefined || (version !== WARN_FORMAT && version !== UNESCALATED_FORMAT)) {
        return undefined;
    }
    const day = stringField(record, 'day');
    const level = numberField(record, 'level');
    const modelLevel = numberField(record, 'modelLevel');
    const ahead = record['ahead'];
    // Absent in a file saved before teamrig kept it: not held.
    const held = record['held'] ?? false;
    const escalated = version === UNESCALATED_FORMAT ? false : record['escalated'];
    const leadTold = record['leadTold'];
    const quietFrom = optionalTime(record, 'quietFrom');
    const marks = [optionalTime(record, 'liftAt'), optionalTime(record, 'burstAt'), optionalTime(record, 'modelBurstAt'), optionalTime(record, 'surplusShown')];
    const [liftAt, burstAt, modelBurstAt, surplusShown] = marks;
    if (day === undefined ||
        level === undefined ||
        modelLevel === undefined ||
        typeof ahead !== 'boolean' ||
        typeof held !== 'boolean' ||
        typeof escalated !== 'boolean' ||
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
        held,
        escalated,
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
        held: state.held,
        escalated: state.escalated,
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
    /** Saves what the session was shown. A file a newer teamrig wrote is refused (`NewerDataError`), never overwritten. */
    async write(id, state) {
        const path = this.pathOf(id);
        writableObject(path, await this.files.read(path), WARN_FORMAT);
        await this.files.write(path, formatWarnState(state));
    }
    pathOf(id) {
        return join(this.folder, `${id}.json`);
    }
}
