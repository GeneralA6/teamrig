import type { InboxMark } from './marks.ts';
import { unreadOf, type LineHash } from './unread.ts';

/**
 * What the prompt hook already showed a Claude Code session of its inbox. The hook keeps one mark per
 * prompt that showed lines, in the read marks' own format, in `inbox-shown.jsonl`: apart from the
 * read marks, so showing a line never marks it read, and binding never follows a shown mark.
 */

/** How much of an inbox one prompt shows: a longer backlog is spread over the next prompts. */
export interface InjectCaps {
  readonly maxLines: number;
  readonly maxChars: number;
}

export const INJECT_CAPS: InjectCaps = { maxLines: 5, maxChars: 1500 };

/** The newest mark the hook left for `claudeSession` on `area`; null when it showed it none of the area's lines. */
export function newestShownOf(marks: readonly InboxMark[], area: string, claudeSession: string | null): InboxMark | null {
  return claudeSession === null ? null : (marks.findLast((mark) => mark.area === area && mark.claudeSession === claudeSession) ?? null);
}

/**
 * The newest mark the hook left on `area` for any Claude Code session: how far the area's session saw its inbox at a
 * prompt, whichever incarnation of it (`inbox status` reads it, as no prompt is its own).
 */
export function lastShownOf(marks: readonly InboxMark[], area: string): InboxMark | null {
  return marks.findLast((mark) => mark.area === area) ?? null;
}

/**
 * The unread lines the hook has not shown this Claude Code session: those after the read mark, or
 * after the shown mark when it is the later one. Both are tails of the same lines, so the shorter tail
 * starts later. A shown mark whose last line is gone (the file was rewritten) counts for nothing.
 */
export function unshownOf(area: string, lines: readonly string[], read: InboxMark | null, shown: InboxMark | null, hash: LineHash): readonly string[] {
  const unread = unreadOf(area, lines, read, hash).lines;
  if (shown === null) {
    return unread;
  }
  const after = unreadOf(area, lines, shown, hash);
  return after.resume !== 'rewritten' && after.lines.length < unread.length ? after.lines : unread;
}

/** A line the hook had to cut to fit: it was not shown whole, so `inbox read` prints it again. */
export function cutWhenShown(line: string, caps: InjectCaps = INJECT_CAPS): boolean {
  return line.length > caps.maxChars;
}
