import type { DecisionCard } from '../register/card.ts';
import type { ServedText } from './text.ts';

/**
 * What a task's wait on a decision or an approval asks, as data: each part of the register's card, written out field
 * by field so a part the register adds is not served by accident. A part the card leaves out is null, so every
 * served card has the same keys.
 */
export interface ServedCard {
  readonly question: string;
  /** Each choice with its numbers; empty on an approval, asked yes or no. */
  readonly options: readonly string[];
  readonly recommend: string;
  /** What happens when no answer comes by the task's due date. */
  readonly byDefault: string;
  /** Why the owner is asked at all, on a task the owner ordered. */
  readonly whyAsk: string | null;
  /** The owner gate or business decision that makes the question the owner's. */
  readonly gate: string | null;
  /** The hand step file the owner runs, by its path. */
  readonly run: string | null;
  /** What a card about a test, measure or proof asks the owner for. */
  readonly affects: string | null;
  /** True when the question reaches the owner only with the security reviewer's verdict on it. */
  readonly security: boolean;
}

/** The card of task `id`, each text scanned under the field `card.<part>`, an option as `card.options`. */
export function servedCard(served: ServedText, id: string, card: DecisionCard): ServedCard {
  return {
    question: served.plain(id, 'card.question', card.question),
    options: card.options.map((option) => served.plain(id, 'card.options', option)),
    recommend: served.plain(id, 'card.recommend', card.recommend),
    byDefault: served.plain(id, 'card.byDefault', card.byDefault),
    whyAsk: served.plainOrNull(id, 'card.whyAsk', card.whyAsk ?? null),
    gate: served.plainOrNull(id, 'card.gate', card.gate ?? null),
    run: served.plainOrNull(id, 'card.run', card.run ?? null),
    affects: served.plainOrNull(id, 'card.affects', card.affects ?? null),
    security: card.security === true,
  };
}
