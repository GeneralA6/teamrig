import { isRecord, stringField } from "../core/guards.js";
import { formatUtcMinute, parseUtcDeadline } from "../core/time.js";
import { SESSION_NAME } from "../register/model.js";
import { lineHash } from "./line-hash.js";
import { CLAUDE_SESSION_ID, indexMarks, MARK_VERSION } from "./marks.js";
import { cutWhenShown, lastShownOf, newestShownOf, unshownOf } from "./shown.js";
import { unreadOf } from "./unread.js";
const LINE_DATE = /^- (\d{4}-\d{2}-\d{2} \d{2}:\d{2})/;
const STAMP_END = '- YYYY-MM-DD HH:MM'.length;
/** When a stored line was posted: its leading `YYYY-MM-DD HH:MM`, in UTC; undefined when it is not dated. */
function postedAt(line) {
    const stamp = LINE_DATE.exec(line)?.[1];
    return stamp === undefined ? undefined : parseUtcDeadline(stamp);
}
/** When the first unread line was posted; undefined when it is not dated. */
export function unreadSince(unread) {
    return postedAt(unread.lines[0] ?? '');
}
/**
 * A stored line as a session reads it, its time on the team's clock: `- 2030-01-08 10:00 lead: …` becomes
 * `- 2030-01-08 12:00 IST lead: …`. The file keeps UTC; a line not dated stays as it is.
 */
export function lineOnClock(line, zone) {
    const at = postedAt(line);
    return at === undefined ? line : `- ${zone.minute(at)}${line.slice(STAMP_END)}`;
}
/** ` since 01-13 13:35 IST`, from the first unread line when it is dated. */
function since(unread, zone) {
    const posted = unreadSince(unread);
    return posted === undefined ? '' : ` since ${zone.shortMinute(posted)}`;
}
/** `, 2 of them shown at a prompt`, when the prompt hook showed some of the unread lines. */
function shownText(status) {
    return status.shown === 0 ? '' : `, ${status.shown} of them shown at a prompt`;
}
/**
 * For `inbox status`: `alpha 3 unread since 01-13 13:35 IST, 2 of them shown at a prompt (read to line 21 of 24 at
 * 01-13 10:57 IST)`.
 */
export function formatStatus(status, zone) {
    const { unread } = status;
    const head = `${unread.area} ${unread.lines.length} unread${since(unread, zone)}${shownText(status)}`;
    const { mark } = unread;
    if (mark === null) {
        return `${head} (never marked read)`;
    }
    const at = zone.shortMinute(new Date(mark.at));
    switch (unread.resume) {
        case 'rewritten':
            return `${head} (the last line read at ${at} is gone: the file was rewritten, all of it counts)`;
        case 'moved':
            return `${head} (lines above the mark were trimmed; read at ${at})`;
        default:
            return `${head} (read to line ${mark.line} of ${unread.total} at ${at})`;
    }
}
/**
 * Hands back the unread lines and marks them read, from one read of the file, so no line slips between.
 * Lines the prompt hook already showed this Claude Code session are marked read without being handed
 * back again, unless the hook had to cut one. An area nobody has posted to yet reads as empty and is
 * still marked, so the prompt hook follows the session from its first read. The caller checks the
 * area is a session on the team.
 */
export async function readInbox(deps, input) {
    const lines = (await deps.inboxes.lines(input.area)) ?? [];
    const { byArea } = indexMarks((await deps.marks.read()).marks);
    const read = byArea.get(input.area) ?? null;
    const unread = unreadOf(input.area, lines, read, lineHash);
    const shown = newestShownOf((await deps.shown.read()).marks, input.area, input.claudeSession);
    const unshown = unshownOf(input.area, lines, read, shown, lineHash);
    const before = unread.lines.slice(0, unread.lines.length - unshown.length);
    const printed = [...before.filter((line) => cutWhenShown(line)), ...unshown];
    const last = lines.at(-1);
    const mark = {
        v: MARK_VERSION,
        area: input.area,
        line: lines.length,
        at: input.now.toISOString(),
        claudeSession: input.claudeSession,
        lastLineHash: last === undefined ? null : lineHash(last),
    };
    await deps.marks.append(mark);
    return { unread, lines: printed, shownBefore: unread.lines.length - printed.length, mark };
}
export function formatRead(result) {
    const { unread, mark, shownBefore } = result;
    const count = result.lines.length;
    const what = count === 0 ? 'nothing new' : `${count} new line${count === 1 ? '' : 's'}, shown above`;
    const before = shownBefore === 0 ? '' : `, and ${shownBefore} the prompt hook showed this session, now marked read too`;
    const redo = unread.resume === 'rewritten' ? ' (the file was rewritten, so all of it is shown)' : '';
    const next = mark.claudeSession === null
        ? 'outside Claude Code, so no prompt will remind you of new ones'
        : 'new ones are shown at your next prompt';
    return `READ ${mark.area}: ${what}${before}${redo}; ${next}`;
}
/** Unread lines per area, and how many of them the prompt hook showed: every area, or one. */
export async function inboxStatus(deps, area) {
    const { byArea } = indexMarks((await deps.marks.read()).marks);
    const shownMarks = (await deps.shown.read()).marks;
    const areas = area === undefined ? await deps.inboxes.areas() : [area];
    const result = [];
    for (const name of areas) {
        const lines = await deps.inboxes.lines(name);
        if (lines !== undefined) {
            const read = byArea.get(name) ?? null;
            const unread = unreadOf(name, lines, read, lineHash);
            const unshown = unshownOf(name, lines, read, lastShownOf(shownMarks, name), lineHash);
            result.push({ unread, shown: unread.lines.length - unshown.length });
        }
    }
    return result;
}
/** Appends one dated line, `- YYYY-MM-DD HH:MM <from>: <text>`, to an area's inbox. */
export async function postLine(inboxes, secrets, input) {
    const text = input.text.trim();
    if (!SESSION_NAME.test(input.to)) {
        return `${input.to} is not a session id`;
    }
    if (text === '' || /[\r\n]/.test(text)) {
        return 'an inbox item is one non-empty line';
    }
    const secret = secrets.refusal('the line', text);
    if (secret !== undefined) {
        return secret;
    }
    await inboxes.append(input.to, `- ${formatUtcMinute(input.now)} ${input.from}: ${text}`);
    return undefined;
}
/** The `session_id` in a hook's parsed stdin JSON; null when absent or malformed. */
export function sessionIdOf(payload) {
    const id = isRecord(payload) ? stringField(payload, 'session_id') : undefined;
    return id !== undefined && CLAUDE_SESSION_ID.test(id) ? id : null;
}
