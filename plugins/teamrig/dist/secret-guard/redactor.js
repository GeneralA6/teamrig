import { isRecord } from "../core/guards.js";
/** The text one result is scanned for at most, in characters; past it the rest stays as it is. */
export const REDACT_CAP = 1_000_000;
/**
 * Replaces each secret in a tool's result before the model and the transcript see it (T1369 R7). Pass 1 scans the
 * string values up to the cap; pass 2 replaces every value found in EVERY string, so a token seen in `stdout` goes from
 * `stderr` too, and a value past the cap goes when it was found before it. The longest value goes first, so a password
 * inside a found URL leaves no part behind.
 */
export class ToolOutputRedactor {
    finders;
    cap;
    constructor(finders, cap = REDACT_CAP) {
        this.finders = finders;
        this.cap = cap;
    }
    redact(response) {
        const { found, cut } = this.scan(stringsOf(response));
        if (found.size === 0)
            return { response, classes: [], cut };
        const longestFirst = [...found].sort(([a], [b]) => b.length - a.length);
        const replace = (text) => longestFirst.reduce((out, [value, description]) => out.split(value).join(`[redacted ${description}]`), text);
        return { response: mapRecord(response, replace), classes: [...new Set(found.values())], cut };
    }
    /** Each secret value in `texts` with its description, the first finder's kept; scanned up to the cap. */
    scan(texts) {
        const found = new Map();
        let room = this.cap;
        let cut = false;
        for (const whole of texts) {
            const text = whole.slice(0, room);
            cut ||= text.length < whole.length;
            room -= text.length;
            for (const finder of this.finders) {
                for (const { value, description } of finder.hitsIn(text)) {
                    if (!found.has(value))
                        found.set(value, description);
                }
            }
        }
        return { found, cut };
    }
}
function isList(value) {
    return Array.isArray(value);
}
/** Every string value in `value`, depth first; keys are not values. */
function stringsOf(value) {
    if (typeof value === 'string')
        return [value];
    if (isList(value))
        return value.flatMap(stringsOf);
    return isRecord(value) ? Object.values(value).flatMap(stringsOf) : [];
}
function mapRecord(record, change) {
    return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, mapStrings(item, change)]));
}
function mapStrings(value, change) {
    if (typeof value === 'string')
        return change(value);
    if (isList(value))
        return value.map((item) => mapStrings(item, change));
    return isRecord(value) ? mapRecord(value, change) : value;
}
