import type { TimeZone } from '../core/zone.ts';
import { lineOnClock, type InboxDeps } from './inbox.ts';
import { lineHash } from './line-hash.ts';
import { boundElsewhereOf, indexMarks, MARK_VERSION, type InboxMark } from './marks.ts';
import { cutWhenShown, INJECT_CAPS, newestShownOf, unshownOf, type InjectCaps } from './shown.ts';
import { unreadOf } from './unread.ts';

/**
 * The prompt hook puts a session's new inbox lines into its prompt, so each line reaches the session
 * inside a turn that happens anyway, instead of a count that costs a turn of its own to read. Each
 * line is shown once per Claude Code session (shown.ts keeps track), and the lines shown whole are
 * marked read, so every unread count stops counting what the session saw (#1401). A line cut to the
 * character cap, and every line after it, stays unread, so `inbox read` prints the cut one whole.
 */

/** The first lines within the caps: one at least, cut to the character cap when it alone is longer. */
export function fitLines(pending: readonly string[], caps: InjectCaps): string[] {
  const out: string[] = [];
  let chars = 0;
  for (const line of pending) {
    if (out.length === caps.maxLines || (out.length > 0 && chars + line.length > caps.maxChars)) {
      break;
    }
    out.push(cutWhenShown(line, caps) ? `${line.slice(0, caps.maxChars)}…` : line);
    chars += line.length;
  }
  return out;
}

/** The hook's text for one prompt, the shown mark to record with it, and the read mark when it reads more. */
export interface Injection {
  readonly text: string;
  readonly shown: InboxMark;
  /** Through the last unread line shown whole before any cut one, now or at an earlier prompt; absent when that reads nothing new. */
  readonly read?: InboxMark;
  /** The command that reads the area's inbox, for a line saying the read mark failed. */
  readonly readAll: string;
}

/** A line the hook cut, on the file's clock or the session's (which adds the zone to its time). */
function wasCut(line: string, zone: TimeZone, caps: InjectCaps): boolean {
  return cutWhenShown(line, caps) || cutWhenShown(lineOnClock(line, zone), caps);
}

export interface InjectionInput {
  readonly area: string;
  /** Where the area's inbox lives, named in the header. */
  readonly path: string;
  readonly lines: readonly string[];
  readonly read: InboxMark | null;
  readonly shown: InboxMark | null;
  readonly claudeSession: string;
  readonly now: Date;
  /** The team's clock, which the lines' times are shown on. */
  readonly zone: TimeZone;
  readonly command: string;
}

/** The lines to show at this prompt, with the mark that records them; undefined when nothing new waits. */
export function injectionOf(input: InjectionInput, caps: InjectCaps = INJECT_CAPS): Injection | undefined {
  const unshown = unshownOf(input.area, input.lines, input.read, input.shown, lineHash);
  const onClock = unshown.map((line) => lineOnClock(line, input.zone));
  const fitted = fitLines(onClock, caps);
  if (fitted.length === 0) {
    return undefined;
  }
  const through = input.lines.length - unshown.length + fitted.length;
  const last = input.lines[through - 1];
  const more = unshown.length - fitted.length;
  const readAll = `${input.command} inbox read --session ${input.area}`;
  const cut = fitted.some((line, index) => line !== onClock[index]);
  const text = [
    `INBOX ${input.area}, new in ${input.path} (each line is shown once, and marked read when shown whole):`,
    ...fitted,
    ...(cut ? [`The line above was cut at ${caps.maxChars} characters; \`${readAll}\` prints it whole.`] : []),
    ...(more > 0 ? [`+${more} more at your next prompt, or all now with: ${readAll}`] : []),
  ];
  const shown: InboxMark = {
    v: MARK_VERSION,
    area: input.area,
    line: through,
    at: input.now.toISOString(),
    claudeSession: input.claudeSession,
    lastLineHash: last === undefined ? null : lineHash(last),
  };
  // The unread lines this session has now seen (shown here or at an earlier prompt) end at `through`; the read mark
  // stops before the first of them that was cut, which `inbox read` must still print whole.
  const unreadFrom = input.lines.length - unreadOf(input.area, input.lines, input.read, lineHash).lines.length;
  let readThrough = unreadFrom;
  while (readThrough < through && !wasCut(input.lines[readThrough] ?? '', input.zone, caps)) {
    readThrough += 1;
  }
  const lastRead = input.lines[readThrough - 1];
  const read: InboxMark | undefined =
    readThrough > unreadFrom ? { ...shown, line: readThrough, lastLineHash: lastRead === undefined ? null : lineHash(lastRead) } : undefined;
  return { text: text.join('\n'), shown, ...(read === undefined ? {} : { read }), readAll };
}

/**
 * The new lines of `area`'s inbox for this prompt, recorded as shown before they are handed back: when
 * the record fails this throws, so a line is never shown twice for want of its record. Then the lines
 * shown whole are marked read; when that mark fails the lines are still shown, with a line saying they
 * stay unread and what reads them. Undefined when the area has no inbox or nothing new.
 */
export async function injectFor(
  deps: InboxDeps,
  input: {
    readonly area: string;
    readonly claudeSession: string;
    readonly now: Date;
    readonly zone: TimeZone;
    readonly command: string;
    /** The sessions on the team's roster, so a tab bound to one is never moved off it. */
    readonly rosterIds: readonly string[];
  },
): Promise<string | undefined> {
  const lines = await deps.inboxes.lines(input.area);
  if (lines === undefined) {
    return undefined;
  }
  const marks = (await deps.marks.read()).marks;
  const { byArea } = indexMarks(marks);
  const shown = newestShownOf((await deps.shown.read()).marks, input.area, input.claudeSession);
  const injection = injectionOf({ ...input, path: deps.inboxes.pathOf(input.area), lines, read: byArea.get(input.area) ?? null, shown });
  if (injection === undefined) {
    return undefined;
  }
  await deps.shown.append(injection.shown);
  if (injection.read === undefined) {
    return injection.text;
  }
  // A read mark carries the tab, and the newest mark binds it: a tab bound to another session (its env names this
  // area, its marks the other) must not be moved by a hook, as `inbox read` refuses it too (T3081).
  const bound = boundElsewhereOf(marks, input.claudeSession, input.area, (id) => input.rosterIds.includes(id));
  if (bound !== undefined) {
    return `${injection.text}\nThese lines stay unread: this tab is the \`${bound}\` session, so it marks nothing read for \`${input.area}\`.`;
  }
  try {
    await deps.marks.append(injection.read);
    return injection.text;
  } catch {
    return `${injection.text}\nThese lines stay unread: their read mark could not be written; \`${injection.readAll}\` reads them.`;
  }
}
