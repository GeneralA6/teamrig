import { isRecord } from "../core/guards.js";
/** The text one result is scanned for at most, in characters; past it the rest stays as it is. */
export const REDACT_CAP = 1_000_000;
/** The accounts a kind names at most: enough to find whose secrets leaked, few enough for a task's description. */
export const MAX_ACCOUNTS = 5;
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
        const { found, accounts, cut } = this.scan(stringsOf(response));
        if (found.size === 0)
            return { response, classes: [], accounts, cut };
        const longestFirst = [...found].sort(([a], [b]) => b.length - a.length);
        const replace = (text) => longestFirst.reduce((out, [value, description]) => out.split(value).join(`[redacted ${description}]`), text);
        return { response: mapRecord(response, replace), classes: [...new Set(found.values())], accounts, cut };
    }
    /** Each secret value in `texts` with its description, the first one found kept, and each kept kind's accounts; scanned up to the cap. */
    scan(texts) {
        const found = new Map();
        const accounts = new Map();
        let room = this.cap;
        let cut = false;
        for (const whole of texts) {
            const text = whole.slice(0, room);
            cut ||= text.length < whole.length;
            room -= text.length;
            for (const finder of this.finders) {
                for (const { value, description, account } of finder.hitsIn(text)) {
                    let kind = found.get(value);
                    if (kind === undefined) {
                        kind = description;
                        found.set(value, kind);
                    }
                    if (account !== undefined)
                        noteAccount(accounts, kind, account);
                }
            }
        }
        return { found, accounts, cut };
    }
}
/** Adds `account` to the accounts named for `kind`, once, up to `MAX_ACCOUNTS`. */
function noteAccount(accounts, kind, account) {
    const named = accounts.get(kind) ?? [];
    if (named.length < MAX_ACCOUNTS && !named.includes(account))
        accounts.set(kind, [...named, account]);
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
