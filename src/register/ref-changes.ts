/**
 * A ref-change file (T1830): rows that point task refs at notes that moved, each `{ team, id, oldRef, newRef }`, and
 * what `teamrig refs apply` does with each row in the caller's team. Pure: the command reads the file and the
 * register, judges each update with the register's own policy, and writes the rows planned `update`.
 */
import { isRecord } from '../core/guards.ts';
import type { RegisterState, Task } from './fold.ts';
import type { Verdict } from './policy.ts';

export interface RefChange {
  /** The team whose register holds the task. */
  readonly team: string;
  readonly id: string;
  /** The ref the task should still read: a ref changed since is left as it is. */
  readonly oldRef: string;
  readonly newRef: string;
}

/** The shape a ref-change file holds, named in a refusal. */
export const REF_CHANGE_SHAPE = '[{"team": "<team>", "id": "T<n>", "oldRef": "<ref now>", "newRef": "<new ref>"}, ...]';

const TASK_ID = /^T\d+$/;

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

export function isRefChange(value: unknown): value is RefChange {
  return (
    isRecord(value) &&
    isText(value['team']) &&
    typeof value['id'] === 'string' &&
    TASK_ID.test(value['id']) &&
    isText(value['oldRef']) &&
    isText(value['newRef'])
  );
}

/** The rows of a parsed ref-change file; refused when it is not a list of rows, a row changes nothing or one task comes twice. */
export function parseRefChanges(raw: unknown): Verdict<readonly RefChange[]> {
  if (!Array.isArray(raw)) {
    return { ok: false, error: `the file holds no list of ref changes: ${REF_CHANGE_SHAPE}` };
  }
  const changes: RefChange[] = [];
  const seen = new Set<string>();
  for (const [index, row] of raw.entries()) {
    const at = `row ${index + 1}`;
    if (!isRefChange(row)) {
      return { ok: false, error: `${at} is not a ref change: ${REF_CHANGE_SHAPE}` };
    }
    if (row.oldRef === row.newRef) {
      return { ok: false, error: `${at} changes nothing: ${row.team}/${row.id} has the same oldRef and newRef` };
    }
    const key = `${row.team}/${row.id}`;
    if (seen.has(key)) {
      return { ok: false, error: `${at} repeats ${key}: give each task one row` };
    }
    seen.add(key);
    changes.push({ team: row.team, id: row.id, oldRef: row.oldRef, newRef: row.newRef });
  }
  return { ok: true, value: changes };
}

/**
 * What becomes of one row: `update` when the task still reads `oldRef` and the policy lets the caller change it; any
 * other row is left, with why.
 */
export type RefRow =
  | { readonly change: RefChange; readonly action: 'update' }
  | { readonly change: RefChange; readonly action: 'already-new' }
  | { readonly change: RefChange; readonly action: 'changed-since'; readonly refNow: string | null }
  | { readonly change: RefChange; readonly action: 'other-team' }
  | { readonly change: RefChange; readonly action: 'not-found'; readonly movedTo: string | undefined }
  | { readonly change: RefChange; readonly action: 'refused'; readonly reason: string };

/** Why the policy refuses the caller's update of `task` to the row's new ref, or undefined when it allows it. */
export type RefJudge = (task: Task, change: RefChange) => string | undefined;

/** Each row's fate in `team`, whose register reads `state`, in the order the rows came. */
export function planRefChanges(changes: readonly RefChange[], team: string, state: RegisterState, judge: RefJudge): readonly RefRow[] {
  return changes.map((change): RefRow => {
    if (change.team !== team) {
      return { change, action: 'other-team' };
    }
    const task = state.tasks.get(change.id);
    if (task === undefined) {
      return { change, action: 'not-found', movedTo: state.moved.get(change.id) };
    }
    if (task.ref === change.newRef) {
      return { change, action: 'already-new' };
    }
    if (task.ref !== change.oldRef) {
      return { change, action: 'changed-since', refNow: task.ref };
    }
    const reason = judge(task, change);
    return reason === undefined ? { change, action: 'update' } : { change, action: 'refused', reason };
  });
}

/** The line `verb` names a row's write by: `WOULD UPDATE` in a dry run, `UPDATED` once written. */
export function updateLine(verb: string, change: RefChange): string {
  return `${verb} ${change.id}: ${change.oldRef} -> ${change.newRef}`;
}

/** The dry run's line for a row: the write it would make, or the row left as it is, with why. */
export function planLine(row: RefRow): string {
  const { id, team, oldRef, newRef } = row.change;
  switch (row.action) {
    case 'update':
      return updateLine('WOULD UPDATE', row.change);
    case 'already-new':
      return `LEFT ${id} (already-new): its ref reads ${newRef}`;
    case 'changed-since':
      return `LEFT ${id} (changed-since): its ref reads ${row.refNow ?? 'none'}, not ${oldRef}`;
    case 'other-team':
      return `LEFT ${team}/${id} (other-team): a session of team ${team} applies it`;
    case 'not-found':
      return row.movedTo === undefined
        ? `LEFT ${id} (not-found): no task ${id} in the working set`
        : `LEFT ${id} (not-found): it moved to team ${row.movedTo}, whose sessions apply it`;
    case 'refused':
      return `LEFT ${id} (refused): ${row.reason}`;
  }
}
