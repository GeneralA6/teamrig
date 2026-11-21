import { isRecord } from "../core/guards.js";
import { ServedText } from "./text.js";
/** What a row says in place of the value of a key that names where a secret is kept. */
export const KEPT_NOTE = 'this key names where a secret is kept, so its value is not served; teamrig config get shows it on the machine';
/** What a row says of a value the config check finds wrong; the check's own words may quote the value. */
export const SETTING_PROBLEM = 'the value fails the config check and the default is used; teamrig config validate says why';
/**
 * The `config` document's body. A value is the team's own words wherever it holds a text, so every string of it is
 * looked at for a secret's shape by itself: each element of a list, each text inside an object, and each key of a
 * map, whose entry is left out when the key itself is cut. The schema's own texts (`meaning`, `enum`, `readOnly`,
 * `gatedBy`) are teamrig's and are served as they are.
 */
export function configBody(input) {
    const served = new ServedText(input.shapes);
    const settings = input.settings.map((row) => {
        const location = row.served === 'location';
        return {
            path: row.path,
            group: row.group,
            type: row.type,
            items: row.items ?? null,
            enum: row.enum === undefined ? null : row.enum.map((choice) => valueOf(choice, AS_WRITTEN)),
            min: row.min ?? null,
            max: row.max ?? null,
            value: location ? null : valueOf(row.value, scanOf(served, row.path, 'value')),
            default: valueOf(row.default, scanOf(served, row.path, 'default')),
            isDefault: row.isDefault,
            meaning: row.meaning,
            editable: row.editable,
            gatedBy: row.gatedBy ?? null,
            readOnly: row.readOnly ?? null,
            problem: row.problem === undefined ? null : SETTING_PROBLEM,
            kept: location ? KEPT_NOTE : null,
        };
    });
    return {
        team: input.team,
        teams: [...input.teams],
        timeZone: input.timeZone,
        priorities: input.priorities.map((name) => served.plain('register.priorities', 'name', name)),
        settings,
        cuts: served.cuts,
    };
}
const AS_WRITTEN = { text: (text) => text, keeps: () => true };
function scanOf(served, path, field) {
    return {
        text: (text) => served.plain(path, field, text),
        // Asking is what lists the cut, under the field `key`, so a reader learns an entry was left out and why.
        keeps: (key) => served.plain(path, 'key', key) === key,
    };
}
/** `value` as JSON holds it; what JSON cannot hold (an unset value, a number that is none) is null. */
function valueOf(value, scan) {
    if (typeof value === 'string') {
        return scan.text(value);
    }
    if (typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : null;
    }
    if (Array.isArray(value)) {
        return value.map((element) => valueOf(element, scan));
    }
    if (isRecord(value)) {
        return Object.fromEntries(Object.entries(value)
            .filter(([key]) => scan.keeps(key))
            .map(([key, child]) => [key, valueOf(child, scan)]));
    }
    return null;
}
