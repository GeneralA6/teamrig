import type { FocusConfig, KitConfig } from '../config/types.ts';
import { MS_PER_DAY } from '../core/time.ts';
import type { Task } from './fold.ts';

/**
 * The park rule (T2076 part 2C): which quiet tasks leave the lists until an event brings them back. Nothing is stored:
 * a task is parked while the rule holds, so any event on it ends that by moving `updatedAt`. Pure, and free of node
 * imports, as the sweep, the reads of the tree and the pane all judge a task by this one rule.
 */

export type ParkFocus = Pick<FocusConfig, 'roadmapClass' | 'maintenanceClass' | 'parkAfterDays'>;

/** What the rule reads of a task; only `id` and `status` are sure, as a tree row may come from a smaller read. */
export type ParkRow = Pick<Task, 'id' | 'status'> & Partial<Pick<Task, 'updatedAt' | 'workClass' | 'pin' | 'critical' | 'source'>>;

export interface ParkInput {
  readonly focus: ParkFocus;
  /** The source that marks the human owner (`register.ownerSource`). */
  readonly ownerSource: string;
  readonly now: number;
  /** True when an active task needs this one, by `after` or a task wait. */
  readonly needed: (id: string) => boolean;
}

/** The team's part of the rule: a read that holds no tree, as the wake's, takes it from the config. */
export type ParkRules = Pick<ParkInput, 'focus' | 'ownerSource'>;

export function parkRulesOf(config: Pick<KitConfig, 'focus' | 'register'>): ParkRules {
  return { focus: config.focus, ownerSource: config.register.ownerSource };
}

/**
 * Whether the task parks, the rule of design section 6 (2C): only a STORED class counts, so a task no one classed never
 * parks, and nothing parks until confirmed rows land. A waiting or verifying task stays out, as parking one would lose
 * its READY and its proof date. A row with no `updatedAt` cannot be called quiet, so it stays. `needed` comes last: it
 * can be the costliest read, and most tasks are out before it.
 */
export function wouldPark(task: ParkRow, input: ParkInput): boolean {
  const { focus } = input;
  const stored = task.workClass ?? null;
  if (stored === null || stored === focus.roadmapClass || stored === focus.maintenanceClass || task.updatedAt === undefined) {
    return false;
  }
  const quietFor = input.now - Date.parse(task.updatedAt);
  return (
    task.status === 'open' &&
    quietFor >= focus.parkAfterDays * MS_PER_DAY &&
    (task.pin ?? null) === null &&
    task.critical !== true &&
    task.source !== input.ownerSource &&
    !input.needed(task.id)
  );
}
