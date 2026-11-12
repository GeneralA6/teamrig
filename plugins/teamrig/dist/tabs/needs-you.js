import { parseObject } from "../core/jsonl.js";
export function isAsking(need) {
    return need.kind !== null && need.text !== null;
}
/** The priority whose ask breaks through the owner's open meeting: p0 alone. */
export const MEETING_BREAKTHROUGH_PRIORITY = 0;
/** The asks of tabs other than `own` (null: every tab), of a kind in `kinds`, newest first. */
export function asksFor(tabs, own, kinds) {
    const wanted = new Set(kinds);
    return tabs
        .filter(isAsking)
        .filter((need) => need.session !== own && wanted.has(need.kind))
        .sort((left, right) => Date.parse(right.since) - Date.parse(left.since) || left.session.localeCompare(right.session));
}
/** Whether an ask offers its Focus: always outside a meeting; during one only for a task of the breakthrough priority. */
export function offersFocus(meetingOpen, priority) {
    return !meetingOpen || priority === MEETING_BREAKTHROUGH_PRIORITY;
}
/** An ask's key: a tab's next ask rewrites its file with a new `since`, so the pair names one ask. */
function sentKey(need) {
    return need.since;
}
/**
 * The asks the OS notification told of, `{ "<session>": "<since>" }`, one per asking tab, so one tab of the team sends
 * each. Rewritten whole under `needsYouLock` with only the tabs asking now, so it holds at most one line per session.
 */
export class NeedsYouSent {
    files;
    path;
    constructor(files, path) {
        this.files = files;
        this.path = path;
    }
    /**
     * The asks in `asking` not told of yet; records every ask in `asking` as told, and forgets tabs asking nothing now.
     * The caller holds the lock.
     */
    async markNew(asking) {
        const sent = parseObject((await this.files.read(this.path)) ?? '') ?? {};
        const fresh = asking.filter((need) => sent[need.session] !== sentKey(need));
        const next = Object.fromEntries(asking.map((need) => [need.session, sentKey(need)]));
        if (fresh.length > 0 || Object.keys(sent).length !== asking.length) {
            await this.files.write(this.path, `${JSON.stringify(next)}\n`);
        }
        return fresh;
    }
}
