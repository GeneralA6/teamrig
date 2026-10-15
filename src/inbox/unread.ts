import type { InboxMark } from './marks.ts';

/**
 * How a reader fingerprints an inbox line to find the last one it read. teamrig passes `lineHash`
 * (`inbox/line-hash.ts`, on node:crypto); a reader without node:crypto passes any function that
 * gives the same value: the first 16 hex digits of the SHA-256 of the line's UTF-8 bytes.
 */
export type LineHash = (line: string) => string;

/**
 * Where reading resumes:
 * - `never`: no mark yet, everything is unread;
 * - `grew`: the last line read is where the mark left it, only later lines are new;
 * - `moved`: lines above the mark were trimmed; the last line read was found higher up;
 * - `rewritten`: the last line read is gone, so everything counts as unread.
 */
export type ResumeKind = 'never' | 'grew' | 'moved' | 'rewritten';

export interface Unread {
  readonly area: string;
  readonly total: number;
  readonly lines: readonly string[];
  readonly mark: InboxMark | null;
  readonly resume: ResumeKind;
}

/** An inbox file's items, as every reader counts them: its non-empty lines, each without a CR line end. */
export function inboxLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.trim() !== '');
}

/** The lines of `area`'s inbox not yet read, after its newest mark (null when it has none). */
export function unreadOf(area: string, lines: readonly string[], mark: InboxMark | null, hash: LineHash): Unread {
  const from = resumeAt(lines, mark, hash);
  return { area, total: lines.length, lines: lines.slice(from.index), mark, resume: from.kind };
}

function resumeAt(lines: readonly string[], mark: InboxMark | null, hash: LineHash): { index: number; kind: ResumeKind } {
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
    if (line !== undefined && hash(line) === mark.lastLineHash) {
      return { index: index + 1, kind: index + 1 === mark.line ? 'grew' : 'moved' };
    }
  }
  return { index: 0, kind: 'rewritten' };
}
