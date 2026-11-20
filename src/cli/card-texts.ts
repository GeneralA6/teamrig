import type { KitConfig } from '../config/types.ts';
import { describedTask } from '../register/description-cut.ts';
import type { Task } from '../register/fold.ts';
import { waitsOnOwner } from '../register/owner-waits.ts';
import type { RegisterSnapshot } from '../register/snapshot.ts';

/**
 * The descriptions an owner's card prints (`what and why:`, cardFacts in src/meeting/agenda.ts). A snapshot's task
 * lines leave descriptions out (T4781), so a command that prints cards takes them from the history here: it reads the
 * history only when a task it shows is cut, and gives only those tasks their text, so every other read of the
 * register stays on the working set.
 */

/** A register as a command read it: its working set, how to read its whole history, and its team's config. */
export interface RegisterRead {
  readonly snapshot: RegisterSnapshot;
  readonly history: () => Promise<RegisterSnapshot>;
  readonly config: KitConfig;
}

/** What a command does to each register it read before it prints from it. */
export type CardRead = <T extends RegisterRead>(read: T) => Promise<T>;

/**
 * The working set with the description of each cut task `shown` selects, as the history holds it. `history` is read
 * once, and only when such a task exists; the tasks keep their order.
 */
export async function withDescriptions(snapshot: RegisterSnapshot, history: () => Promise<RegisterSnapshot>, shown: (task: Task) => boolean): Promise<RegisterSnapshot> {
  const cut = [...snapshot.state.tasks.values()].filter((task) => task.descriptionCut !== null && shown(task));
  if (cut.length === 0) {
    return snapshot;
  }
  const whole = (await history()).state.tasks;
  const tasks = new Map(snapshot.state.tasks);
  for (const task of cut) {
    tasks.set(task.id, describedTask(task, whole.get(task.id)));
  }
  return { ...snapshot, state: { ...snapshot.state, tasks } };
}

/** The register as read: for a command that prints no card's description. */
export const asRead: CardRead = (read) => Promise.resolve(read);

/**
 * The register with the description of every task that waits on its team's owner (waitsOnOwner): each card the
 * meeting's agenda, `decisions` and `meet --cards` print is one of those.
 */
export const withCardTexts: CardRead = async (read) => {
  const owner = read.config.register.ownerSource;
  return { ...read, snapshot: await withDescriptions(read.snapshot, read.history, (task) => waitsOnOwner(task, owner)) };
};
