import { errorMessage } from '../core/guards.ts';
import type { TimeZone } from '../core/zone.ts';
import { lineOnClock, type InboxDeps } from './inbox.ts';
import { lineHash } from './line-hash.ts';
import { indexMarks, MARK_VERSION, type InboxMark } from './marks.ts';
import { cutWhenShown, INJECT_CAPS, newestShownOf, unshownOf, type InjectCaps } from './shown.ts';
import { unreadOf } from './unread.ts';

/**
 * The prompt hook puts a session's new inbox lines into its prompt, so each line reaches the session
 * inside a turn that happens anyway, instead of a count that costs a turn of its own to read. Each
 * line is shown once per Claude Code session (shown.ts keeps track), and a line shown whole is marked read (T3216):
 * the session has seen it, so no unread count (`inbox status`, doctor, the pane) goes on counting it. A line cut to
 * fit stays unread, and so does every line after it, until `inbox read` prints it whole.
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

/** The hook's text for one prompt, the shown mark to record with it, and the read mark through the lines shown whole. */
export interface Injection {
  readonly text: string;
  readonly shown: InboxMark;
  /** Null when the first unread line is one cut to fit, so nothing more is read. */
  readonly read: InboxMark | null;
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
  const more = unshown.length - fitted.length;
  const readAll = `${input.command} inbox read --session ${input.area}`;
  const cut = fitted.some((line, index) => line !== onClock[index]);
  const text = [
    `INBOX ${input.area}, new in ${input.path} (each line is shown once, and marked read once shown whole):`,
    ...fitted,
    ...(cut ? [`The line above was cut at ${caps.maxChars} characters; \`${readAll}\` prints it whole.`] : []),
    ...(more > 0 ? [`+${more} more at your next prompt, or all now with: ${readAll}`] : []),
  ];
  // The unread lines in order, each true when a prompt showed it whole: those shown before this prompt (unless one was
  // cut, as inbox read tells it), then this prompt's. The read mark stops before the first one cut.
  const unread = unreadOf(input.area, input.lines, input.read, lineHash).lines;
  const readFrom = input.lines.length - unread.length;
  const earlier = unread.slice(0, unread.length - unshown.length).map((line) => !cutWhenShown(line, caps));
  const whole = [...earlier, ...fitted.map((line, index) => line === onClock[index])];
  const firstCut = whole.indexOf(false);
  const readThrough = readFrom + (firstCut === -1 ? whole.length : firstCut);
  return { text: text.join('\n'), shown: markThrough(input, through), read: readThrough > readFrom ? markThrough(input, readThrough) : null };
}

/** A mark of `input`'s area through its first `through` lines, for this Claude Code session at this prompt. */
function markThrough(input: InjectionInput, through: number): InboxMark {
  const last = input.lines[through - 1];
  return { v: MARK_VERSION, area: input.area, line: through, at: input.now.toISOString(), claudeSession: input.claudeSession, lastLineHash: last === undefined ? null : lineHash(last) };
}

/**
 * The new lines of `area`'s inbox for this prompt, recorded as shown before they are handed back: when
 * the record fails this throws, so a line is never shown twice for want of its record. Those shown whole
 * are then marked read; when that fails the lines are still handed back, saying they stay unread, since
 * they are recorded as shown. Undefined when the area has no inbox or nothing new.
 */
export async function injectFor(
  deps: InboxDeps,
  input: { readonly area: string; readonly claudeSession: string; readonly now: Date; readonly zone: TimeZone; readonly command: string },
): Promise<string | undefined> {
  const lines = await deps.inboxes.lines(input.area);
  if (lines === undefined) {
    return undefined;
  }
  const { byArea } = indexMarks((await deps.marks.read()).marks);
  const shown = newestShownOf((await deps.shown.read()).marks, input.area, input.claudeSession);
  const injection = injectionOf({ ...input, path: deps.inboxes.pathOf(input.area), lines, read: byArea.get(input.area) ?? null, shown });
  if (injection === undefined) {
    return undefined;
  }
  await deps.shown.append(injection.shown);
  if (injection.read === null) {
    return injection.text;
  }
  try {
    await deps.marks.append(injection.read);
    return injection.text;
  } catch (error) {
    const readAll = `${input.command} inbox read --session ${input.area}`;
    return `${injection.text}\nThey stay unread, as ${input.command} could not mark them read (${errorMessage(error)}); \`${readAll}\` does.`;
  }
}
