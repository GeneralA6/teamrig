import { formatUtcMinute, MS_PER_DAY, parseUtcDeadline, shortUtc } from "../core/time.js";
import { unreadSince } from "../inbox/inbox.js";
import { TEAM_RULES_MAX_CHARS } from "../rules/pack.js";
/**
 * Days an inbox may wait with unread lines and no read before doctor flags it. Hard-coded for now;
 * a candidate config key if teams want it tighter or looser.
 */
export const UNREAD_INBOX_DAYS = 7;
function plural(count, one, many) {
    return count === 1 ? one : many;
}
/** Names that find the wrong session, or none: a removed session's, a shared current one, a former one taken over. */
function nameFindings(roster, command) {
    const findings = [];
    const gone = new Map();
    const shared = new Set();
    for (const [name, holder] of roster.allNames()) {
        if (!roster.ids.includes(holder)) {
            gone.set(holder, [...(gone.get(holder) ?? []), name]);
            continue;
        }
        const current = roster.idsCalled(name);
        if (current.length > 1) {
            shared.add(name);
        }
        else if (current.length === 1 && !current.includes(holder)) {
            findings.push({ kind: 'name-shared', detail: `${name} was a name of ${holder} but is now the name of ${current.join(', ')}, so it no longer finds ${holder}` });
        }
    }
    for (const name of shared) {
        const ids = roster.idsCalled(name).join(', ');
        findings.push({ kind: 'name-shared', detail: `${name} is the name of ${ids}, so commands refuse it: give each its own with \`${command} rename\`` });
    }
    for (const [id, names] of gone) {
        const these = plural(names.length, 'was a name', 'were names');
        findings.push({ kind: 'name-gone', detail: `${names.join(', ')} ${these} of ${id}, which is no longer on the team: commands refuse them, filters read them as ${id}` });
    }
    return findings;
}
/** A config name the rename log never gave the session: someone edited the config to rename it, and the log wins. */
function configFindings(input) {
    const { roster, renameLog, command } = input;
    return Object.entries(input.configNames).flatMap(([id, configured]) => {
        const current = roster.nameOf(id);
        const logged = renameLog.renames.some((rename) => rename.id === id && (rename.from === configured || rename.to === configured));
        if (current === undefined || current === configured || logged) {
            return [];
        }
        const detail = `the config names ${id} "${configured}", but the rename log calls it ${current} and the log wins: to rename it, run \`${command} rename ${id} ${configured}\``;
        return [{ kind: 'name-config', detail }];
    });
}
function renameLogFindings(input) {
    const { path, unreadable, newer } = input.renameLog;
    const findings = [];
    if (unreadable > 0) {
        findings.push({ kind: 'rename-log', detail: `${path} has ${unreadable} damaged line(s), skipped: the names they record do not resolve until fixed` });
    }
    if (newer > 0) {
        findings.push({ kind: 'rename-log', detail: `${path} has ${newer} line(s) from a newer ${input.command}, skipped: no rename can be recorded until ${input.command} is updated` });
    }
    return findings;
}
/** When an inbox started waiting: its last read, else its first unread line; undefined when neither is known. */
function waitingSince(unread) {
    if (unread.mark !== null) {
        return new Date(unread.mark.at);
    }
    const posted = unreadSince(unread);
    return posted === undefined ? undefined : parseUtcDeadline(posted);
}
/** Inboxes nobody reads: one keyed by no session id on the team, or unread lines with no read for days. */
function inboxFindings(input) {
    const { roster, now } = input;
    return input.inboxes.flatMap((unread) => {
        const { area, mark } = unread;
        const count = unread.lines.length;
        if (!roster.ids.includes(area)) {
            const found = roster.lookup(area);
            const hint = found.ok ? `; ${area} is a name of ${found.id}, whose inbox is keyed by its id` : '';
            const detail = `inbox ${area} (${count} unread) is no session's: inboxes are keyed by session id, so nobody reads it${hint}; nothing moves its lines`;
            return [{ kind: 'inbox-orphan', detail }];
        }
        const since = waitingSince(unread);
        if (count === 0 || (since !== undefined && now.getTime() - since.getTime() <= UNREAD_INBOX_DAYS * MS_PER_DAY)) {
            return [];
        }
        const read = mark === null ? 'has never read it' : `last read it ${shortUtc(formatUtcMinute(new Date(mark.at)))}`;
        return [{ kind: 'inbox-unread', detail: `${area} has ${count} unread line(s) and ${read}: over ${UNREAD_INBOX_DAYS} days with no read` }];
    });
}
function rulesFindings(input) {
    const rules = input.teamRules;
    if (rules === undefined || rules.chars <= TEAM_RULES_MAX_CHARS) {
        return [];
    }
    const detail = `${rules.path} is ${rules.chars} characters, more than the ${TEAM_RULES_MAX_CHARS} a session is shown at start, so sessions get only a pointer to it: shorten it to keep it in every session's context`;
    return [{ kind: 'rules-long', detail }];
}
/**
 * The team's health checks: names that find the wrong session or none, a damaged rename log,
 * inboxes nobody reads, and rules too long to show. It reads only; every fix is the user's.
 */
export function doctorFindings(input) {
    return [...nameFindings(input.roster, input.command), ...configFindings(input), ...renameLogFindings(input), ...inboxFindings(input), ...rulesFindings(input)];
}
export function formatFinding(finding) {
    return `WARN ${finding.kind} ${finding.detail}`;
}
