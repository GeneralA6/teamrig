import type { ItemType, TaskFields } from './events.ts';

/** What an item of one type does beyond a plain task's (T1252). */
export interface ItemTypeTraits {
  /** Whether it gives the problem review (review.ts) to reach a `register.review.requireOn` status, and so can be marked critical. */
  readonly review: boolean;
}

/** One row per item type (ITEM_TYPES), so a later type (an incident, an epic) is one more row here. */
export const ITEM_TYPE_TRAITS: { readonly [T in ItemType]: ItemTypeTraits } = {
  task: { review: false },
  bug: { review: true },
};

/** What a task is: its type, a task when no one set one. */
export function itemTypeOf(task: Pick<TaskFields, 'type'>): ItemType {
  return task.type ?? 'task';
}

/** The traits of a task's type. */
export function traitsOf(task: Pick<TaskFields, 'type'>): ItemTypeTraits {
  return ITEM_TYPE_TRAITS[itemTypeOf(task)];
}
