import { isRecord, stringField } from "../core/guards.js";
import { formatUtcMinute, shortUtc } from "../core/time.js";
import { SESSION_NAME } from "../register/model.js";
import { CLAUDE_SESSION_ID, indexMarks, lineHash, MARK_VERSION } from "./marks.js";
export function unreadOf(area, lines, mark) {
    const from = resumeAt(lines, mark);
    return { area, total: lines.length, lines: lines.slice(from.index), mark, resume: from.kind };
}
function resumeAt(lines, mark) {
    if (mark === null) {
        return { index: 0, kind: 'never' };
    }
    if (mark.lastLineHash === null) {
        // A v0 mark knows only a count: trust it unless the file shrank below it.
        return mark.line > lines.length ? { index: 0, kind: 'rewritten' } : { index: mark.line, kind: 'grew' };
    }
    if (mark.line === 0) {
        return { index: 0, kind: 'grew' };
    }
    // Trimming the top shifts the last line read upwards, so search from the mark down to the top.
    for (let index = Math.min(mark.line, lines.length) - 1; index >= 0; index -= 1) {
        const line = lines[index];
        if (line !== undefined && lineHash(line) === mark.lastLineHash) {
            return { index: index + 1, kind: index + 1 === mark.line ? 'grew' : 'moved' };
        }
    }
    return { index: 0, kind: 'rewritten' };
}
const LINE_DATE = /^- (\d{4}-\d{2}-\d{2} \d{2}:\d{2})/;
/** ` since 01-13 11:35`, from the first unread line when it is dated. */
function since(unread) {
    const date = LINE_DATE.exec(unread.lines[0] ?? '')?.[1];
    return date === undefined ? '' : ` since ${shortUtc(date)}`;
}
/** For `inbox status`: `alpha 3 unread since 01-13 11:35 (read to line 21 of 24 at 01-13 08:57)`. */
export function formatUnread(unread) {
    const head = `${unread.area} ${unread.lines.length} unread${since(unread)}`;
    const { mark } = unread;
    if (mark === null) {
        return `${head} (never marked read)`;
    }
    const at = shortUtc(formatUtcMinute(new Date(mark.at)));
    switch (unread.resume) {
        case 'rewritten':
            return `${head} (the last line read at ${at} is gone: the file was rewritten, all of it counts)`;
        case 'moved':
            return `${head} (lines above the mark were trimmed; read at ${at})`;
        default:
            return `${head} (read to line ${mark.line} of ${unread.total} at ${at})`;
    }
}
/** The hook's one line; undefined when nothing is unread. */
export function reminderLine(unread, path, command) {
    return unread.lines.length === 0
        ? undefined
        : `INBOX: ${unread.lines.length} unread line(s) in ${path}${since(unread)}. Read them with: ${command} inbox read --session ${unread.area}`;
}
/**
 * Hands back the unread lines and marks them read, from one read of the file, so no line slips between.
 * An area nobody has posted to yet reads as empty and is still marked, so the reminder hook follows
 * the session from its first read. The caller checks the area is a session on the team.
 */
export async function readInbox(deps, input) {
    const lines = (await deps.inboxes.lines(input.area)) ?? [];
    const { byArea } = indexMarks((await deps.marks.read()).marks);
    const unread = unreadOf(input.area, lines, byArea.get(input.area) ?? null);
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
    return { unread, mark };
}
export function formatRead(result) {
    const { unread, mark } = result;
    const what = unread.lines.length === 0 ? 'nothing new' : `the ${unread.lines.length} line(s) above`;
    const redo = unread.resume === 'rewritten' ? ' (the file was rewritten, so all of it is shown)' : '';
    const hook = mark.claudeSession === null
        ? 'no Claude Code session id here, so no reminder follows this session'
        : 'the reminder hook follows this session';
    return `READ ${mark.area}: ${what}${redo}, read to line ${mark.line}; ${hook}`;
}
/** Unread lines per area: every area, or one. */
export async function inboxStatus(deps, area) {
    const { byArea } = indexMarks((await deps.marks.read()).marks);
    const areas = area === undefined ? await deps.inboxes.areas() : [area];
    const result = [];
    for (const name of areas) {
        const lines = await deps.inboxes.lines(name);
        if (lines !== undefined) {
            result.push(unreadOf(name, lines, byArea.get(name) ?? null));
        }
    }
    return result;
}
/** The reminder for a Claude Code session; undefined until it has read an inbox once, or when nothing is unread. */
export async function reminderFor(deps, claudeSession, command) {
    const { byArea, areaBySession } = indexMarks((await deps.marks.read()).marks);
    const area = areaBySession.get(claudeSession);
    const lines = area === undefined ? undefined : await deps.inboxes.lines(area);
    if (area === undefined || lines === undefined) {
        return undefined;
    }
    return reminderLine(unreadOf(area, lines, byArea.get(area) ?? null), deps.inboxes.pathOf(area), command);
}
/** Appends one dated line, `- YYYY-MM-DD HH:MM <from>: <text>`, to an area's inbox. */
export async function postLine(inboxes, secrets, input) {
    const text = input.text.trim();
    if (!SESSION_NAME.test(input.to)) {
        return `${input.to} is not a session name`;
    }
    if (text === '' || /[\r\n]/.test(text)) {
        return 'an inbox item is one non-empty line';
    }
    if (secrets.looksSecret(text)) {
        return 'the line looks like it holds a secret; refer to where it is kept instead';
    }
    await inboxes.append(input.to, `- ${formatUtcMinute(input.now)} ${input.from}: ${text}`);
    return undefined;
}
/** The `session_id` in a hook's parsed stdin JSON; null when absent or malformed. */
export function sessionIdOf(payload) {
    const id = isRecord(payload) ? stringField(payload, 'session_id') : undefined;
    return id !== undefined && CLAUDE_SESSION_ID.test(id) ? id : null;
}
