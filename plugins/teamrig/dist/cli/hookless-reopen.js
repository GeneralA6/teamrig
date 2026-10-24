import { KIT_NAME } from "../core/home.js";
import { MS_PER_MINUTE } from "../core/time.js";
/**
 * Reopened tabs no teamrig hook started in (T1100), kept pure: a tab's SessionStart hook writes its session's record
 * (src/sessions/record.ts) at each start, so a session whose newest log record is a reopen while its record is still
 * from before its close runs in a tab that loaded no teamrig, as one that loaded its plugins while an install was
 * copied (T561). It gets no inbox, guards or tab status, and no one watches a tab the idle pass reopened. The Stop
 * hook's hookless-tab check (src/restore/hookless.ts) never sees it: a tab with no hook since its start has no
 * restore entry.
 */
/** How long a reopened tab may run before its first hook is missed: well past any tab's start, a resume's included. */
export const FIRST_HOOK_MS = 5 * MS_PER_MINUTE;
/** The session's close the reopen at `index` follows: its record before it, when that is a close. */
function closeBefore(records, index, id) {
    const before = records.slice(0, index).findLast((record) => record.session === id);
    return before?.kind === 'close' ? before : undefined;
}
/**
 * The sessions of `ids` whose newest log record is a reopen at least `FIRST_HOOK_MS` old (one after now, the clock
 * gone back, is not) and whose start record, in `starts`, is missing or no newer than the close before it. The close,
 * not the reopen: no tab of the session runs between the two, and the reopen is logged only after its tab opened, so
 * a quick tab's first hook can come before it. With no close found, the reopen's own time.
 */
export function hooklessReopensOf(records, starts, ids, now) {
    return ids.flatMap((id) => {
        const index = records.findLastIndex((record) => record.session === id);
        const reopen = records[index];
        if (reopen?.kind !== 'reopen') {
            return [];
        }
        const at = Date.parse(reopen.at);
        if (!(now - at >= FIRST_HOOK_MS)) {
            return [];
        }
        const since = Date.parse(closeBefore(records, index, id)?.at ?? reopen.at);
        const start = starts.get(id);
        return start === undefined || !(Date.parse(start.at) > since) ? [{ id, at, resumed: reopen.resumed }] : [];
    });
}
/**
 * The line naming a hookless reopen, written at `now`: a tab that resumed its Claude Code session resumes it again
 * in the same terminal once the plugins settled, and one that opened fresh lost nothing, so it opens again.
 */
export function hooklessReopenLine(reopen, roster, zone, now) {
    const minutes = Math.floor((now - reopen.at) / MS_PER_MINUTE);
    const restart = reopen.resumed === undefined ? `run ${KIT_NAME} open ${reopen.id}` : `run claude --resume ${reopen.resumed} in its terminal`;
    return (`HOOKLESS ${roster.nameOf(reopen.id) ?? reopen.id} (session ${reopen.id}): reopened ${zone.shortMinute(new Date(reopen.at))}, and no teamrig hook ` +
        `has started in its tab in the ${minutes} min since, so it gets no inbox, guards or tab status: /exit that tab and ${restart}`);
}
