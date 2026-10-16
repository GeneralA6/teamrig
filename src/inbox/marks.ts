import { isNonNegativeInteger, stringField } from '../core/guards.ts';
import { parseJsonl, type JsonlRecord } from '../core/jsonl.ts';
import { SESSION_NAME } from '../register/model.ts';

export const MARK_VERSION = 1;

/** A Claude Code session id, as hook stdin and `$CLAUDE_CODE_SESSION_ID` carry it. */
export const CLAUDE_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Records that `area` has read its inbox through its first `line` non-empty lines, and which
 * Claude Code session did: the reminder hook finds a session's area by its newest mark.
 * `lastLineHash` (v1) fingerprints the last line read, so a reader can tell a trimmed or edited
 * inbox from one that only grew; v0 marks have none.
 */
export interface InboxMark {
  readonly v: number;
  readonly area: string;
  readonly line: number;
  readonly at: string;
  readonly claudeSession: string | null;
  readonly lastLineHash: string | null;
}

export type MarkParse =
  | { readonly kind: 'mark'; readonly mark: InboxMark }
  | { readonly kind: 'newer' }
  | { readonly kind: 'unreadable' };

export function parseMark(line: JsonlRecord): MarkParse {
  if (line.version > MARK_VERSION) {
    return { kind: 'newer' };
  }
  const { record } = line;
  const area = stringField(record, 'area');
  const count = record['line'];
  const at = stringField(record, 'at');
  const claudeSession = record['claudeSession'] ?? null;
  const lastLineHash = record['lastLineHash'] ?? null;
  const valid =
    area !== undefined &&
    SESSION_NAME.test(area) &&
    isNonNegativeInteger(count) &&
    at !== undefined &&
    !Number.isNaN(Date.parse(at)) &&
    (claudeSession === null || (typeof claudeSession === 'string' && CLAUDE_SESSION_ID.test(claudeSession))) &&
    (lastLineHash === null || typeof lastLineHash === 'string');
  return valid ? { kind: 'mark', mark: { v: line.version, area, line: count, at, claudeSession, lastLineHash } } : { kind: 'unreadable' };
}

export interface MarkLogRead {
  readonly marks: readonly InboxMark[];
  readonly unreadable: number;
  readonly newer: number;
}

/** The marks an `inbox-marks.jsonl` text holds, in write order; damaged and newer lines are counted, never fatal. */
export function readMarks(text: string): MarkLogRead {
  const parse = parseJsonl(text);
  const marks: InboxMark[] = [];
  let unreadable = parse.unreadable;
  let newer = 0;
  for (const line of parse.records) {
    const result = parseMark(line);
    if (result.kind === 'mark') {
      marks.push(result.mark);
    } else if (result.kind === 'newer') {
      newer += 1;
    } else {
      unreadable += 1;
    }
  }
  return { marks, unreadable, newer };
}

export interface MarkIndex {
  readonly byArea: ReadonlyMap<string, InboxMark>;
  readonly areaBySession: ReadonlyMap<string, string>;
}

/**
 * The Claude Code session that last read `area`'s inbox and is still bound to it (its own newest mark names
 * `area`); undefined when none is on record.
 */
export function lastClaudeSessionOf(marks: readonly InboxMark[], area: string): string | undefined {
  const bound = indexMarks(marks).areaBySession;
  const mark = [...marks].reverse().find((found) => found.area === area && found.claudeSession !== null && bound.get(found.claudeSession) === area);
  return mark?.claudeSession ?? undefined;
}

/** The newest mark wins, both for an area's read position and for a session's area. */
export function indexMarks(marks: readonly InboxMark[]): MarkIndex {
  const byArea = new Map<string, InboxMark>();
  const areaBySession = new Map<string, string>();
  for (const mark of marks) {
    byArea.set(mark.area, mark);
    if (mark.claudeSession !== null) {
      areaBySession.set(mark.claudeSession, mark.area);
    }
  }
  return { byArea, areaBySession };
}
