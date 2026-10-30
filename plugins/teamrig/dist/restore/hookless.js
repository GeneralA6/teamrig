import { parseTranscriptLine } from "../budget/line.js";
import { roleHolderOf } from "../config/roster.js";
import { parseObject, toJsonlLine, VERSION_FIELD } from "../core/jsonl.js";
import { MS_PER_MINUTE } from "../core/time.js";
/**
 * Tabs that run without teamrig's hooks, kept pure: a session's restore entry is its hooks' heartbeat (written at
 * each prompt and turn end, and every few minutes of a turn's tool calls), and the model's replies in its
 * transcript are the turns it runs. A reply long after the entry's last write is a turn run with its hooks off, as
 * after a plugin update a tab never reloaded: it gets no inbox, no guards and no tab status. A transcript also
 * moves with no turn, and so with no hook: each /reload-plugins (the person's, or the reload hand's after every
 * plugin update), away summaries and Claude Code's own notes; only a reply counts (T1055). A reload never brings a
 * tab's hooks back, only a restart does. The check names each such tab once (`hooklessNews`) to whoever can tell
 * its person, and again only after it had its hooks back.
 */
/** The format of the check's state file this code reads and writes; a file in another format reads as no check yet. */
export const HOOKLESS_STATE_FORMAT = 1;
/**
 * How far a reply runs past its entry's last write before the tab reads as hookless: well past the few minutes
 * between a turn's heartbeats (`TOOL_END_WRITE_MS`), and past the longest single tool call, during which neither
 * moves.
 */
export const HOOKLESS_MS = 30 * MS_PER_MINUTE;
/** How often the Stop hooks check, across the team. */
export const HOOKLESS_CHECK_MS = 10 * MS_PER_MINUTE;
/**
 * How much of a transcript's end the check reads for its last reply: a working tab writes one every few lines, so
 * only a result line longer than this hides it, and the next check sees past it. Read only for a transcript that
 * moved lately, well past its last hook (`workedPastHook`).
 */
export const HOOKLESS_TAIL_BYTES = 256 * 1024;
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
 * The team session an entry's tab runs as: the one its variables name when they name `team` (`teamrig launch`
 * sets them), else, for a tab started by hand, which names no team, the session whose inbox it last read (T1002).
 * Undefined for a tab of another team, or of a session the team no longer has, as a retired hire whose tab stayed
 * open: neither is the team's to tell (T1055).
 */
export function entrySession(entry, team) {
    const session = entry.team === undefined ? team.areaBySession.get(entry.claudeSession) : entry.team === team.team ? entry.session : undefined;
    return session !== undefined && team.sessions.includes(session) ? session : undefined;
}
/**
 * The entries whose transcript the check reads: a live tab of one of `team`'s sessions (`entrySession`, not
 * ended, with a transcript) whose hooks last wrote more than `HOOKLESS_MS` ago. Only these cost a file's stat,
 * and only those whose file `workedPastHook` the end of the file.
 */
export function staleEntries(entries, team, now) {
    return entries.flatMap((entry) => {
        const session = entrySession(entry, team);
        const stale = session !== undefined && entry.endedAt === undefined && entry.transcriptPath !== undefined && now - entry.updatedAt > HOOKLESS_MS;
        return stale ? [{ entry, session }] : [];
    });
}
/**
 * Whether something the tab did at `at` reads as work without hooks: within the last `HOOKLESS_MS` (the session
 * works now) and more than `HOOKLESS_MS` after its hooks' last write at `hookAt`. Its file's last change passing
 * this is what makes the check read a transcript's end, since a reply is never later than the file's change.
 */
export function workedPastHook(hookAt, at, now) {
    return now - at <= HOOKLESS_MS && at - hookAt > HOOKLESS_MS;
}
/**
 * The main thread's last reply in a transcript's lines, in epoch ms; undefined where they hold none (`lines` holds
 * whole lines only: a caller reading from inside a file drops its first). A helper's reply (a sidechain) is left
 * out: a helper's tool ends write the heartbeat, but its replies can outlive its parent's turn.
 */
export function lastReplyAt(lines) {
    let turnAt;
    for (const raw of lines) {
        const line = parseTranscriptLine(raw);
        if (line !== undefined && line.at !== undefined && line.kind === 'call' && line.mainThread) {
            turnAt = Math.max(turnAt ?? line.at, line.at);
        }
    }
    return turnAt;
}
/**
 * The tabs that run without their hooks: a stale entry whose last reply `workedPastHook`. `replies` holds the last
 * reply at each stale entry's transcript end, by Claude Code session; one it lacks (not read, no file, no reply)
 * is skipped.
 */
export function hooklessTabs(stale, replies, now) {
    return stale.flatMap(({ entry, session }) => {
        const turnAt = replies.get(entry.claudeSession);
        if (turnAt === undefined || !workedPastHook(entry.updatedAt, turnAt, now)) {
            return [];
        }
        return [{ claudeSession: entry.claudeSession, session, projectDir: entry.projectDir, hookAt: entry.updatedAt, turnAt }];
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
 * Who of team `team` hears of a hookless tab: its lead, or the delivery owner when the lead's own tab is
 * hookless, since the lead's inbox reminder is one of the hooks it lacks; that owner may sit on a team above, which a
 * child team leaves the role to (roleHolderOf, T1143). With no delivery owner, the lead still. The idle pass asks
 * it too, for a reopened tab no hook started in (src/cli/hookless-reopen.ts), which has no entry.
 */
export function hooklessReader(tab, roles, team) {
    const deliveryOwner = roleHolderOf(roles, 'deliveryOwner', team);
    return tab.session === roles.lead && deliveryOwner !== undefined ? deliveryOwner : { team, id: roles.lead };
}
/**
 * The inbox line naming a hookless tab, written at `now`, its times on `zone`'s clock: `14:20 IDT` on the line's
 * day, else with their date (`10-20 16:37 IDT`), so a tab hookless for days does not read as hours (T1069). It
 * asks for a restart in the tab's folder, never a reload: a /reload-plugins does not bring a tab's hooks back
 * (T1055). It names the tab's session as `session`, as the reader's team writes it: `app/lead` on a team above.
 */
export function hooklessLine(tab, session, zone, now) {
    const today = zone.day(new Date(now));
    const time = (at) => {
        const date = new Date(at);
        return zone.day(date) === today ? zone.clock(date) : zone.shortMinute(date);
    };
    const minutes = Math.round((tab.turnAt - tab.hookAt) / MS_PER_MINUTE);
    return (`HOOKLESS ${session}: its tab (Claude session ${tab.claudeSession.slice(0, 8)}) worked ${minutes} min past its last teamrig hook ` +
        `(hook ${time(tab.hookAt)}, last reply ${time(tab.turnAt)}), so it gets no inbox, guards or tab status: ` +
        `/exit that tab and run claude --resume ${tab.claudeSession} in ${tab.projectDir}`);
}
