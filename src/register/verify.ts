import { formatUtcDay, parseUtcDay } from '../core/time.ts';
import { taskNumber, type Task } from './fold.ts';
import type { TaskStatus } from './model.ts';
import { needsOf } from './tree.ts';

/** `Proof: ...` or `Proof = ...` in a note written before `--proof` existed: what follows names the proof. */
const NOTE_PROOF = /\bproof\s*[:=]\s*(.+)$/i;

/**
 * What will prove a verifying task works: its `--proof`; for a task set verifying before `--proof` existed,
 * what its note says after `Proof:`, else the whole note. Read side only: old lines are never rewritten.
 */
export function proofOf(task: Pick<Task, 'proof' | 'note'>): string | null {
  if (task.proof !== null || task.note === null) {
    return task.proof;
  }
  const named = NOTE_PROOF.exec(task.note)?.[1]?.trim();
  return named === undefined || named === '' ? task.note : named;
}

/**
 * The tasks a task needs first that are still verifying: its plan dependencies (`after`), then the tasks
 * it waits on, each once. A shipped change is not proven yet, so work built on it waits for the proof.
 */
export function verifyingNeeds(task: Pick<Task, 'after' | 'waits'>, tasks: ReadonlyMap<string, Task>): Task[] {
  return needsOf(task).flatMap((id) => {
    const needed = tasks.get(id);
    return needed?.status === 'verifying' ? [needed] : [];
  });
}

/** The verifying tasks that hold a status change: only a move into in-progress from another status is held. */
export function startHolds(task: Task, status: TaskStatus, tasks: ReadonlyMap<string, Task>): Task[] {
  return status === 'in-progress' && task.status !== 'in-progress' ? verifyingNeeds(task, tasks) : [];
}

/** `T2 needs T1, still verifying (proof: ..., owner bravo)`: what holds the start, for the refusal or the warning. */
export function heldStart(task: Pick<Task, 'id'>, holds: readonly Task[]): string {
  const named = holds.map((held) => `${held.id}, still verifying (proof: ${proofText(held)}, owner ${held.owner})`);
  return `${task.id} needs ${named.join(', and ')}`;
}

/** The inbox line a held start leaves the verifying task's owner. */
export function heldStartNotice(task: Pick<Task, 'id'>, held: Task): string {
  return `${task.id} waits on your verifying ${held.id}: ${proofText(held)}`;
}

/** The inbox line a start that named its held proof as met (`--met`) leaves the verifying task's owner. */
export function metStartNotice(task: Pick<Task, 'id'>, held: Task, met: string): string {
  return `${task.id} started on your verifying ${held.id}, its proof met: ${met}; set ${held.id} done if that holds, else reopen it`;
}

/** The proof as a line names it: `no proof named` for a task set verifying with neither proof nor note. */
export function proofText(task: Pick<Task, 'proof' | 'note'>): string {
  return proofOf(task) ?? 'no proof named';
}

/** A session's verifying tasks, oldest first: the order to prove them in. */
export function verifyQueue(tasks: Iterable<Task>, owner: string): Task[] {
  return [...tasks]
    .filter((task) => task.status === 'verifying' && task.owner === owner)
    .sort((a, b) => Date.parse(a.statusAt) - Date.parse(b.statusAt) || taskNumber(a.id) - taskNumber(b.id));
}

/** True once the UTC day of the task's verify-by date, its due date, has come. */
export function verifyByArrived(task: Pick<Task, 'due'>, now: Date): boolean {
  const day = task.due?.slice(0, 10);
  return day !== undefined && parseUtcDay(day) !== undefined && day <= formatUtcDay(now);
}
