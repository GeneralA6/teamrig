import type { Files } from '../core/files.ts';
import { stringField } from '../core/guards.ts';
import { parseObject } from '../core/jsonl.ts';

/** Enough of the transcript to hold its last entry: the fire's entry carries the job's prompt. */
export const SCHEDULED_TAIL_BYTES = 64 * 1024;

/**
 * Whether the prompt a UserPromptSubmit hook sees was fired by a scheduled job (CronCreate) rather than typed: its
 * payload says neither way, but Claude Code writes the fire's `system`/`scheduled_task_fire` entry before the hook
 * runs and the prompt's own entry only after, so the transcript then ends with the fire. A typed prompt's
 * transcript ends with the last turn's entries instead.
 */
export function endsWithScheduledFire(tail: string): boolean {
  const lines = tail.split('\n').filter((line) => line.trim() !== '');
  const last = lines.length === 0 ? undefined : parseObject((lines[lines.length - 1] ?? '').trim());
  return last !== undefined && stringField(last, 'type') === 'system' && stringField(last, 'subtype') === 'scheduled_task_fire';
}

/** `endsWithScheduledFire` of the transcript at `transcript`; false when it is unknown or unreadable. */
export async function firedBySchedule(files: Files, transcript: string | undefined): Promise<boolean> {
  if (transcript === undefined) {
    return false;
  }
  const tail = await files.readTail(transcript, SCHEDULED_TAIL_BYTES).catch(() => undefined);
  return tail !== undefined && endsWithScheduledFire(tail);
}
