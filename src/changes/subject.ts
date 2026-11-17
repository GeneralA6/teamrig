import { releaseVersionOf } from './git.ts';
import type { ChangeKind } from './source.ts';
import { oneLine } from './sources/shared.ts';

/** The Conventional Commits types; any other prefix (`open: ...`) is the area itself. */
const CONVENTIONAL_TYPES: ReadonlySet<string> = new Set(['feat', 'fix', 'docs', 'perf', 'refactor', 'test', 'build', 'ci', 'chore', 'style', 'revert']);

/** Types whose commits change only how the project is built or tested: no user of the project sees them. */
const DEVELOPER_TYPES: ReadonlySet<string> = new Set(['refactor', 'test', 'build', 'ci', 'chore', 'style']);

/** `type(scope)!: text` or `area: text`. */
const PREFIXED = /^([A-Za-z][\w-]*)(?:\(([^)]*)\))?(!)?:\s+(.+)$/;

/** A task id (`T3387`) or a pull request or issue number (`#1373`) a subject names. */
const TASK_ID = /\bT\d+\b/g;
const NUMBER_REF = /(?<![\w/])#\d+\b/g;

/** The whole of a trailing `(T12)` or `(T12, T13)`, tested only on the text from its last `(`. */
const TASK_SUFFIX = /^\((?:T\d+(?:,\s*)?)+\)$/;

/** One commit subject, read for a change entry. */
export interface ReadSubject {
  readonly area: string;
  readonly kind: ChangeKind;
  /** The subject past its prefix, with the task ids in parentheses at its end taken off. */
  readonly text: string;
  readonly taskIds: readonly string[];
  readonly numbers: readonly string[];
  /** A release commit: it names a version, not a change. */
  readonly release: boolean;
  /** A release commit or a build, test or tooling one: nothing a user of the project reads. */
  readonly hidden: boolean;
}

/** What a commit's subject and body say of the change: its area, kind and refs. */
export function readSubject(subject: string, body: string = ''): ReadSubject {
  const line = oneLine(subject).trim();
  const taskIds = [...new Set(line.match(TASK_ID) ?? [])];
  const numbers = [...new Set(line.match(NUMBER_REF) ?? [])];
  const release = releaseVersionOf(line) !== undefined;
  const breaking = /^BREAKING[ -]CHANGE:/m.test(body);
  const match = PREFIXED.exec(line);
  if (match === null) {
    return { area: 'general', kind: breaking ? 'behaviour' : 'other', text: tidy(line), taskIds, numbers, release, hidden: release };
  }
  const [, prefix = '', scope, bang, rest = ''] = match;
  const type = prefix.toLowerCase();
  const conventional = CONVENTIONAL_TYPES.has(type);
  const area = (conventional ? scope : prefix)?.trim().toLowerCase() || 'general';
  return {
    area,
    kind: bang === '!' || breaking ? 'behaviour' : type === 'feat' ? 'feature' : type === 'fix' ? 'fix' : 'other',
    text: tidy(rest),
    taskIds,
    numbers,
    release,
    hidden: release || (conventional && DEVELOPER_TYPES.has(type)),
  };
}

/**
 * Drops a trailing `(T12)` or `(T12, T13)`: the ids go to the entry's refs. Its `(` is found by index, as a pattern
 * free to start anywhere rescans the spaces before each start, quadratic in a long subject.
 */
function tidy(text: string): string {
  const trimmed = text.trimEnd();
  const open = trimmed.lastIndexOf('(');
  return (open !== -1 && TASK_SUFFIX.test(trimmed.slice(open)) ? trimmed.slice(0, open) : trimmed).trim();
}

/** A commit's short sha as refs carry it, so two sources naming one commit name it alike. */
export function shortSha(sha: string): string {
  return sha.slice(0, 9);
}
