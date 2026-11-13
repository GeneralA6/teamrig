import { formatUtcDay } from '../core/time.ts';
import type { ImportChanges, ImportInput, StatusInput, Verdict } from '../register/policy.ts';
import type { WriteResult } from '../register/register.ts';
import type { SyncStep } from './plan.ts';

const DAY_MS = 86_400_000;

/** The register's import writes (register.ts), the only writes a sync makes. */
export interface ImportWriter {
  importAdd(input: ImportInput): Promise<Verdict<WriteResult>>;
  importUpdate(id: string, changes: ImportChanges, note: string): Promise<Verdict<WriteResult>>;
  importStatus(id: string, input: StatusInput): Promise<Verdict<WriteResult>>;
}

/** A step as written: the task it wrote, or why the register refused it. */
export interface StepOutcome {
  readonly step: SyncStep;
  readonly result: Verdict<string>;
}

/** The first day whose closed issues a sync reads: `closedDays` before now, UTC. */
export function closedSince(now: Date, closedDays: number): string {
  return formatUtcDay(new Date(now.getTime() - closedDays * DAY_MS));
}

/** Writes the steps in order, each judged again under the register's lock; a refused step is reported and the rest still run. */
export async function applySteps(writer: ImportWriter, steps: readonly SyncStep[]): Promise<StepOutcome[]> {
  const outcomes: StepOutcome[] = [];
  for (const step of steps) {
    const verdict = await writeStep(writer, step);
    outcomes.push({ step, result: verdict.ok ? { ok: true, value: verdict.value.task.id } : verdict });
  }
  return outcomes;
}

function writeStep(writer: ImportWriter, step: SyncStep): Promise<Verdict<WriteResult>> {
  switch (step.kind) {
    case 'add':
      return writer.importAdd(step.input);
    case 'update':
      return writer.importUpdate(step.id, step.changes, step.note);
    case 'status':
      return writer.importStatus(step.id, step.input);
  }
}
