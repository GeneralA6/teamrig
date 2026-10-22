import { KIT_NAME } from '../core/home.ts';
import type { Task } from '../register/fold.ts';
import type { AddInput, StatusInput, Verdict } from '../register/policy.ts';
import type { WriteResult } from '../register/register.ts';
import type { RegisterSnapshot } from '../register/snapshot.ts';
import type { Checked } from './team-create.ts';

/**
 * The lead's first task in a new root team: setting the team up with the user (skill team-setup). `team create`
 * adds it to the team's task list and starts it, so the setup shows in the task pane and the register like any
 * work, and the lead closes it once every session runs its first task. A repeat never adds a second: it keeps the
 * one there, and a team that already has other tasks is past its setup, so it gets none.
 */

/** The register writes the setup task takes. */
export interface SetupTaskRegister {
  snapshot(): Promise<RegisterSnapshot>;
  add(caller: string, input: AddInput): Promise<Verdict<WriteResult>>;
  setStatus(caller: string, id: string, input: StatusInput): Promise<Verdict<WriteResult>>;
}

export const SETUP_TASK_TITLE = 'Set up the team';

const SETUP_TASK_DESCRIPTION =
  'Set the team up with the user (skill team-setup): ask what they want the team to do, give each session its first task and open it, then settle the budget and the local rules. Done once every session runs its first task.';

/** The setup task the lead owns, from the user, who asked for the team. */
export function setupTaskInput(lead: string, ownerSource: string): AddInput {
  return { title: SETUP_TASK_TITLE, description: SETUP_TASK_DESCRIPTION, owner: lead, source: ownerSource, priority: 1 };
}

/** What a run does about the setup task: add it, keep the one there, or none, for a team already at work. */
export type SetupTaskStep = { readonly kind: 'add' } | { readonly kind: 'keep'; readonly task: Task } | { readonly kind: 'none' };

export function setupTaskStep(snapshot: RegisterSnapshot, lead: string): SetupTaskStep {
  const tasks = [...snapshot.state.tasks.values()];
  const task = tasks.find((found) => found.title === SETUP_TASK_TITLE && found.owner === lead);
  if (task !== undefined) {
    return { kind: 'keep', task };
  }
  return tasks.length === 0 ? { kind: 'add' } : { kind: 'none' };
}

/** What the run did: the setup task it added and started, the one it kept, or none. */
export type SetupTaskOutcome = { readonly kind: 'added' | 'kept'; readonly task: Task } | { readonly kind: 'none' };

/** Adds the setup task and starts it, as the lead, when {@link setupTaskStep} says so. */
export async function applySetupTask(register: SetupTaskRegister, lead: string, ownerSource: string): Promise<Checked<SetupTaskOutcome>> {
  const step = setupTaskStep(await register.snapshot(), lead);
  if (step.kind !== 'add') {
    return { ok: true, value: step.kind === 'keep' ? { kind: 'kept', task: step.task } : step };
  }
  const added = await register.add(lead, setupTaskInput(lead, ownerSource));
  if (!added.ok) {
    return { ok: false, problem: added.error };
  }
  const started = await register.setStatus(lead, added.value.task.id, { status: 'in-progress' });
  return started.ok ? { ok: true, value: { kind: 'added', task: started.value.task } } : { ok: false, problem: started.error };
}

/** The line a run prints for its setup task; none when the team is past its setup. */
export function setupTaskLines(outcome: SetupTaskOutcome, lead: string): string[] {
  switch (outcome.kind) {
    case 'none':
      return [];
    case 'kept':
      return [`UNCHANGED ${outcome.task.id} ${SETUP_TASK_TITLE} (${outcome.task.status}, owner ${outcome.task.owner}): the task list already has the team's setup`];
    case 'added':
      return [
        `ADDED ${outcome.task.id} ${SETUP_TASK_TITLE}, in progress, owner ${lead}: close it with ${KIT_NAME} set ${outcome.task.id} --status done once every session runs its first task`,
      ];
  }
}

/** The line a dry run prints: what a run would do about the setup task. */
export function setupTaskDryLines(step: SetupTaskStep, lead: string): string[] {
  switch (step.kind) {
    case 'none':
      return [];
    case 'keep':
      return setupTaskLines({ kind: 'kept', task: step.task }, lead);
    case 'add':
      return [`WOULD ADD ${SETUP_TASK_TITLE}, in progress, owner ${lead}`];
  }
}
