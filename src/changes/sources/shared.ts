import type { ChangeQuery, ChangeRead } from '../source.ts';

/** The paths a git read narrows to: the asked file or folder, else the whole project. */
export function pathsOf(query: ChangeQuery): string[] {
  return query.file === undefined ? [] : [query.file];
}

/** The line breaks `.` does not cross: outside text can carry one inside a line. */
const LINE_BREAKS = /[\r\n\u2028\u2029]/g;

/**
 * Outside text as one line, each line break a space. A pattern ending `(.+)$` stops at a break and backtracks over
 * the text before it, quadratic in its length, so text from a commit or a note is made one line before any pattern.
 */
export function oneLine(text: string): string {
  return text.replace(LINE_BREAKS, ' ');
}

/** A read that threw, as the failed read the core prints beside the other sources' entries. */
export function readFailure(error: unknown): ChangeRead {
  return { kind: 'failed', error: error instanceof Error ? error.message : String(error) };
}
