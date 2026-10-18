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
