import type { BudgetConfig } from '../config/types.ts';
import { formatUtcDay } from '../core/time.ts';
import type { WarnStore } from './warn-store.ts';

/**
 * A budget release (T2801): a change that ends the hold of sessions past their daily budget. A held session takes no
 * turns, so no hook of its own sees the release; whoever makes it wakes the sessions it frees with an inbox line.
 */

/** How a budget policy change frees held sessions: turned off, or made warn-only; undefined when it frees none. */
export type PolicyRelease = 'off' | 'warn';

/** Whether the new policy frees sessions the old one could hold: off, or warn after a holding action. */
export function policyReleaseOf(before: Pick<BudgetConfig, 'enabled' | 'overAction'>, after: Pick<BudgetConfig, 'enabled' | 'overAction'>): PolicyRelease | undefined {
  // Warn never held anyone, so a team that warned before frees no one either way.
  if (!before.enabled || before.overAction === 'warn') {
    return undefined;
  }
  if (!after.enabled) {
    return 'off';
  }
  return after.overAction === 'warn' ? 'warn' : undefined;
}

/**
 * The sessions of `ids` held at their last turn's end today (UTC day of `now`), in `ids` order. A warn state of an
 * earlier day says nothing of today: the new day's budget already freed it, and its next turn starts the day over.
 */
export async function heldToday(store: WarnStore, ids: readonly string[], now: number): Promise<string[]> {
  const day = formatUtcDay(new Date(now));
  const held: string[] = [];
  for (const id of ids) {
    const state = await store.read(id);
    if (state !== undefined && state.day === day && state.held) {
      held.push(id);
    }
  }
  return held;
}

/** The line a freed session gets: who freed it and how, and that it carries on. */
export function releaseLineOf(by: string, how: string): string {
  return `Budget: ${by} ${how}, so your budget hold is over: carry on with your task list.`;
}
