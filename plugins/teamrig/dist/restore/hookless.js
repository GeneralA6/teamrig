import { parseObject, toJsonlLine, VERSION_FIELD } from "../core/jsonl.js";
import { MS_PER_MINUTE } from "../core/time.js";
/**
 * Tabs that run without teamrig's hooks, kept pure: a session's restore entry is its hooks' heartbeat (written at
 * each prompt and turn end, and every few minutes of a turn's tool calls), and its transcript is what the session
 * does. A transcript that moves long after the entry's last write is a tab working with its hooks off, as after a
 * plugin update a tab never reloaded: it gets no inbox, no guards and no tab status. The check names each such
 * tab once (`hooklessNews`) to whoever can tell its person, and again only after it had its hooks back.
 */
/** The format of the check's state file this code reads and writes; a file in another format reads as no check yet. */
export const HOOKLESS_STATE_FORMAT = 1;
/**
 * How far a transcript runs past its entry's last write before the tab reads as hookless: well past the few
 * minutes between a turn's heartbeats (`TOOL_END_WRITE_MS`), and past the longest single tool call, during which
 * neither moves.
 */
export const HOOKLESS_MS = 30 * MS_PER_MINUTE;
/** How often the Stop hooks check, across the team. */
export const HOOKLESS_CHECK_MS = 10 * MS_PER_MINUTE;
function isTime(value) {
    return typeof value === 'number' && Number.isFinite(value);
}
/** The state file's content; undefined when it is damaged or from another format, which reads as no check yet. */
export function parseHooklessState(text) {
    const record = parseObject(text.trim());
    if (record === undefined || record[VERSION_FIELD] !== HOOKLESS_STATE_FORMAT) {
        return undefined;
    }
    const { checkedAt, told } = record;
    if (!isTime(checkedAt) || !Array.isArray(told)) {
        return undefined;
    }
    const sessions = told.filter((id) => typeof id === 'string');
    return sessions.length === told.length ? { checkedAt, told: sessions } : undefined;
}
export function formatHooklessState(state) {
    return toJsonlLine({ [VERSION_FIELD]: HOOKLESS_STATE_FORMAT, checkedAt: state.checkedAt, told: [...state.told] });
}
/** Whether a hook checks now: `HOOKLESS_CHECK_MS` passed since the last check, or the clock went back past it. */
export function isCheckDue(state, now) {
    return state === undefined || now < state.checkedAt || now - state.checkedAt >= HOOKLESS_CHECK_MS;
}
/**
 * The entries whose transcript the check reads: a live session of `team` (named, not ended, with a transcript)
 * whose hooks last wrote more than `HOOKLESS_MS` ago. Only these cost a file's stat.
 */
export function staleEntries(entries, team, now) {
    return entries.filter((entry) => entry.team === team && entry.session !== undefined && entry.endedAt === undefined && entry.transcriptPath !== undefined && now - entry.updatedAt > HOOKLESS_MS);
}
/**
 * The tabs that run without their hooks: a stale entry whose transcript changed within the last `HOOKLESS_MS`
 * (the session works now) and more than `HOOKLESS_MS` after the entry's last write. `transcriptAt` holds each
 * stale entry's transcript change, by Claude Code session; one it lacks (no file) is skipped.
 */
export function hooklessTabs(stale, transcriptAt, now) {
    return stale.flatMap((entry) => {
        const changed = transcriptAt.get(entry.claudeSession);
        if (entry.session === undefined || changed === undefined || now - changed > HOOKLESS_MS || changed - entry.updatedAt <= HOOKLESS_MS) {
            return [];
        }
        return [{ claudeSession: entry.claudeSession, session: entry.session, hookAt: entry.updatedAt, transcriptAt: changed }];
    });
}
/** The tabs a check names: hookless now and not named at the last check. */
export function hooklessNews(state, tabs) {
    const told = new Set(state?.told ?? []);
    return tabs.filter((tab) => !told.has(tab.claudeSession));
}
/** What a check writes: its time and the tabs hookless now, so a tab that had its hooks back is named again later. */
export function checkedState(now, tabs) {
    return { checkedAt: now, told: tabs.map((tab) => tab.claudeSession) };
}
/**
 * Who hears of a hookless tab: the lead, or the coordinator's owner when the lead's own tab is hookless, since
 * the lead's inbox reminder is one of the hooks it lacks. With no coordinator's owner, the lead still.
 */
export function hooklessReader(tab, lead, coordinatorOwner) {
    return tab.session === lead && coordinatorOwner !== undefined ? coordinatorOwner : lead;
}
/** The inbox line naming a hookless tab, its times as `clock` writes them (`14:20 IDT`). */
export function hooklessLine(tab, clock) {
    const minutes = Math.round((tab.transcriptAt - tab.hookAt) / MS_PER_MINUTE);
    return (`HOOKLESS ${tab.session}: its tab (Claude session ${tab.claudeSession.slice(0, 8)}) worked ${minutes} min past its last teamrig hook ` +
        `(hook ${clock(new Date(tab.hookAt))}, transcript ${clock(new Date(tab.transcriptAt))}), so it gets no inbox, guards or tab status: ` +
        `type /reload-plugins in that tab`);
}
