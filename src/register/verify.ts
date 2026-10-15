import type { Task } from './fold.ts';

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
