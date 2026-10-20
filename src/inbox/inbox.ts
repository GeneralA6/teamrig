import { isRecord, stringField } from '../core/guards.ts';
import { formatUtcMinute, parseUtcDeadline } from '../core/time.ts';
import type { SecretScanner } from '../core/secrets.ts';
import type { TimeZone } from '../core/zone.ts';
import { SESSION_NAME } from '../register/model.ts';
import { lineHash } from './line-hash.ts';
import { CLAUDE_SESSION_ID, indexMarks, MARK_VERSION, type InboxMark, type MarkLogRead } from './marks.ts';
import { cutWhenShown, lastShownOf, newestShownOf, unshownOf } from './shown.ts';
import { unreadOf, type Unread } from './unread.ts';

/** The inbox files: one per area, one dated line per item. */
export interface Inboxes {
  areas(): Promise<string[]>;
  /** The area's non-empty lines; undefined when it has no inbox. */
  lines(area: string): Promise<string[] | undefined>;
  append(area: string, line: string): Promise<void>;
  /** Where the area's inbox lives, for messages. */
  pathOf(area: string): string;
}

export interface MarkLog {
  read(): Promise<MarkLogRead>;
  append(mark: InboxMark): Promise<void>;
}

const LINE_DATE = /^- (\d{4}-\d{2}-\d{2} \d{2}:\d{2})/;
const STAMP_END = '- YYYY-MM-DD HH:MM'.length;

/** When a stored line was posted: its leading `YYYY-MM-DD HH:MM`, in UTC; undefined when it is not dated. */
function postedAt(line: string): Date | undefined {
  const stamp = LINE_DATE.exec(line)?.[1];
  return stamp === undefined ? undefined : parseUtcDeadline(stamp);
}

/** When the first unread line was posted; undefined when it is not dated. */
export function unreadSince(unread: Unread): Date | undefined {
  return postedAt(unread.lines[0] ?? '');
}

/**
 * A stored line as a session reads it, its time on the team's clock: `- 2030-01-08 10:00 lead: …` becomes
 * `- 2030-01-08 12:00 IST lead: …`. The file keeps UTC; a line not dated stays as it is.
 */
export function lineOnClock(line: string, zone: TimeZone): string {
  const at = postedAt(line);
  return at === undefined ? line : `- ${zone.minute(at)}${line.slice(STAMP_END)}`;
}

/** ` since 01-13 13:35 IST`, from the first unread line when it is dated. */
function since(unread: Unread, zone: TimeZone): string {
  const posted = unreadSince(unread);
  return posted === undefined ? '' : ` since ${zone.shortMinute(posted)}`;
}

/** An area's unread lines, and how many of them the prompt hook already showed its session. */
export interface InboxStatus {
  readonly unread: Unread;
  /**
   * Unread lines the prompt hook showed a Claude Code session of the area: the session saw them, but showing marks
   * nothing read, so only `inbox read` takes them off the unread count.
   */
  readonly shown: number;
}

/** `, 2 of them shown at a prompt`, when the prompt hook showed some of the unread lines. */
function shownText(status: InboxStatus): string {
  return status.shown === 0 ? '' : `, ${status.shown} of them shown at a prompt`;
}

/**
 * For `inbox status`: `alpha 3 unread since 01-13 13:35 IST, 2 of them shown at a prompt (read to line 21 of 24 at
 * 01-13 10:57 IST)`.
 */
export function formatStatus(status: InboxStatus, zone: TimeZone): string {
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

export interface InboxDeps {
  readonly inboxes: Inboxes;
  /** The read marks (`inbox-marks.jsonl`). */
  readonly marks: MarkLog;
  /** What the prompt hook showed each Claude Code session (`inbox-shown.jsonl`). */
  readonly shown: MarkLog;
}

export interface ReadResult {
  readonly unread: Unread;
  /** The unread lines to print: all but those the prompt hook already showed this Claude Code session whole. */
  readonly lines: readonly string[];
  /** Unread lines the prompt hook already showed this Claude Code session, marked read without printing. */
  readonly shownBefore: number;
  readonly mark: InboxMark;
}

/**
 * Hands back the unread lines and marks them read, from one read of the file, so no line slips between.
 * Lines the prompt hook already showed this Claude Code session are marked read without being handed
 * back again, unless the hook had to cut one. An area nobody has posted to yet reads as empty and is
 * still marked, so the prompt hook follows the session from its first read. The caller checks the
 * area is a session on the team.
 */
export async function readInbox(
  deps: InboxDeps,
  input: { readonly area: string; readonly claudeSession: string | null; readonly now: Date },
): Promise<ReadResult> {
  const lines = (await deps.inboxes.lines(input.area)) ?? [];
  const { byArea } = indexMarks((await deps.marks.read()).marks);
  const read = byArea.get(input.area) ?? null;
  const unread = unreadOf(input.area, lines, read, lineHash);
  const shown = newestShownOf((await deps.shown.read()).marks, input.area, input.claudeSession);
  const unshown = unshownOf(input.area, lines, read, shown, lineHash);
  const before = unread.lines.slice(0, unread.lines.length - unshown.length);
  const printed = [...before.filter((line) => cutWhenShown(line)), ...unshown];
  const last = lines.at(-1);
  const mark: InboxMark = {
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

export function formatRead(result: ReadResult): string {
  const { unread, mark, shownBefore } = result;
  const count = result.lines.length;
  const what = count === 0 ? 'nothing new' : `${count} new line${count === 1 ? '' : 's'}, shown above`;
  const before = shownBefore === 0 ? '' : `, and ${shownBefore} the prompt hook showed this session, now marked read too`;
  const redo = unread.resume === 'rewritten' ? ' (the file was rewritten, so all of it is shown)' : '';
  const next =
    mark.claudeSession === null
      ? 'outside Claude Code, so no prompt will remind you of new ones'
      : 'new ones are shown at your next prompt';
  return `READ ${mark.area}: ${what}${before}${redo}; ${next}`;
}

/** Unread lines per area, and how many of them the prompt hook showed: every area, or one. */
export async function inboxStatus(deps: InboxDeps, area?: string): Promise<InboxStatus[]> {
  const { byArea } = indexMarks((await deps.marks.read()).marks);
  const shownMarks = (await deps.shown.read()).marks;
  const areas = area === undefined ? await deps.inboxes.areas() : [area];
  const result: InboxStatus[] = [];
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

export interface PostInput {
  readonly to: string;
  readonly from: string;
  readonly text: string;
  readonly now: Date;
}

/** Appends one dated line, `- YYYY-MM-DD HH:MM <from>: <text>`, to an area's inbox. */
export async function postLine(inboxes: Inboxes, secrets: SecretScanner, input: PostInput): Promise<string | undefined> {
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
export function sessionIdOf(payload: unknown): string | null {
  const id = isRecord(payload) ? stringField(payload, 'session_id') : undefined;
  return id !== undefined && CLAUDE_SESSION_ID.test(id) ? id : null;
}
