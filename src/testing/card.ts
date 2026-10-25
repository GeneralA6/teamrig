import type { DecisionCard } from '../register/card.ts';

/** A card the policy takes: a decision with two options, every part a few plain words. */
export const TEST_CARD: DecisionCard = {
  question: 'Which pricing tier ships first',
  options: ['Basic at 9 dollars a month', 'Pro at 29 dollars a month'],
  recommend: 'Basic, the cheaper launch',
  byDefault: 'Basic ships on the due date',
};

/** TEST_CARD as `set` flags. */
export const TEST_CARD_FLAGS: readonly string[] = [
  '--question',
  TEST_CARD.question,
  '--options',
  TEST_CARD.options.join(' | '),
  '--recommend',
  TEST_CARD.recommend,
  '--default',
  TEST_CARD.byDefault,
];

/** An owner gate of the default config, as a card on a wait on the owner's decision names it (T1194). */
export const TEST_GATE = 'budget';

/** TEST_CARD as a wait on the owner's decision takes it: naming its gate. */
export const TEST_OWNER_CARD: DecisionCard = { ...TEST_CARD, gate: TEST_GATE };

/** TEST_OWNER_CARD as `set` flags. */
export const TEST_OWNER_CARD_FLAGS: readonly string[] = [...TEST_CARD_FLAGS, '--gate', TEST_GATE];
