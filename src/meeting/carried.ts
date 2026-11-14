import type { RegisterEvent } from '../register/events.ts';
import { cardLabel, decisionKey, type Decision } from './decision-order.ts';
import { isOwnerAnswer } from './notices.ts';

/**
 * What a meeting carries over to the next (T2775, design T2773 D): a card is done in a meeting once the lead recorded
 * the owner's answer on it, a Decided or a Later (isOwnerAnswer); every other card the agenda asked at its end carries,
 * and the next agenda asks it first. A carried card whose wait on the owner cleared meanwhile is no longer asked, so it
 * drops out by itself.
 */

/** One register's events, the name the lead records answers by on it, and its label under the lead's (undefined for the lead's own). */
export interface AnsweredRead {
  readonly events: readonly RegisterEvent[];
  readonly decidedBy: string;
  readonly team: string | undefined;
}

/** The keys (decisionKey) of the cards the lead recorded an owner's answer on since `since`, over every register read. */
export function answeredKeys(reads: readonly AnsweredRead[], since: number): Set<string> {
  const keys = new Set<string>();
  for (const { events, decidedBy, team } of reads) {
    for (const event of events) {
      if (event.type === 'update' && event.by === decidedBy && Date.parse(event.at) >= since && isOwnerAnswer(event)) {
        keys.add(cardLabel(team, event.id));
      }
    }
  }
  return keys;
}

/** The keys of the cards asked, in the agenda's order, that got no answer: those the meeting carries over. */
export function carriedKeys(asked: readonly Decision[], answered: ReadonlySet<string>): string[] {
  return asked.map(decisionKey).filter((key) => !answered.has(key));
}
