import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TEST_CARD } from '../testing/card.ts';
import { cardLines, cardProblem, cardTexts, namedTaskIds, parseCard, plainWords, sameCard, withoutWhyAsk } from './card.ts';

const WHY_ASK = 'the ordered tier cannot ship at that price';

describe('the decision card', () => {
  it('counts the plain words a text says, task ids apart', () => {
    assert.equal(plainWords('30 days: 4 GB'), 4);
    assert.equal(plainWords('option B of T378'), 3);
    assert.equal(plainWords('(T378), T12.'), 0);
    assert.equal(plainWords('T0 and T12x'), 3, 'only an id standing as a word is one');
  });

  it('lists each task id the texts name once, in the order first named', () => {
    assert.deepEqual(namedTaskIds(['T5 before T12', 'then T5 again, and (T7)']), ['T5', 'T12', 'T7']);
    assert.deepEqual(namedTaskIds(['no ids here']), []);
  });

  it('passes a card whose every part reads on its own', () => {
    assert.equal(cardProblem(TEST_CARD, true), undefined);
    assert.equal(cardProblem({ ...TEST_CARD, options: [] }, false), undefined, 'an approval asks yes or no');
  });

  it('refuses a part that is a bare task number, naming the part', () => {
    assert.equal(
      cardProblem({ ...TEST_CARD, options: ['Basic at 9 dollars a month', 'T378 option B'] }, true),
      '--options choice 2 says "T378 option B": give at least 3 plain words besides task ids, so it reads without the task list',
    );
    assert.match(cardProblem({ ...TEST_CARD, byDefault: 'T5' }, true) ?? '', /^--default says "T5"/);
    assert.match(cardProblem({ ...TEST_CARD, whyAsk: 'see T5' }, true) ?? '', /^--why-ask says "see T5"/);
    assert.equal(cardProblem({ ...TEST_CARD, whyAsk: WHY_ASK }, true), undefined);
  });

  it('asks a decision for two options at least, and never takes one alone', () => {
    assert.equal(cardProblem({ ...TEST_CARD, options: [] }, true), '--options lists 0: a decision lists at least 2, separated by |');
    assert.equal(
      cardProblem({ ...TEST_CARD, options: ['Basic at 9 dollars'] }, false),
      '--options lists 1: a decision lists at least 2, separated by |; an approval lists none or as many',
    );
  });

  it('compares cards part by part', () => {
    assert.equal(sameCard(TEST_CARD, { ...TEST_CARD, options: [...TEST_CARD.options] }), true);
    assert.equal(sameCard(TEST_CARD, { ...TEST_CARD, options: [...TEST_CARD.options].reverse() }), false);
    assert.equal(sameCard(TEST_CARD, { ...TEST_CARD, options: TEST_CARD.options.slice(1) }), false);
    assert.equal(sameCard(TEST_CARD, { ...TEST_CARD, recommend: 'Pro, since it pays more' }), false);
    assert.equal(sameCard(TEST_CARD, { ...TEST_CARD, whyAsk: WHY_ASK }), false);
    assert.equal(sameCard({ ...TEST_CARD, whyAsk: WHY_ASK }, { ...TEST_CARD, whyAsk: WHY_ASK }), true);
    assert.equal(sameCard(null, null), true);
    assert.equal(sameCard(TEST_CARD, null), false);
  });

  it('reads a card from a register line, or says why it is not one', () => {
    assert.equal(parseCard(undefined), undefined);
    assert.equal(parseCard(null), undefined);
    assert.deepEqual(parseCard({ ...TEST_CARD, extra: 1 }), TEST_CARD, 'a field a newer teamrig adds is ignored');
    assert.equal(parseCard('a card'), 'card is not an object');
    assert.equal(parseCard({ ...TEST_CARD, byDefault: 3 }), 'card needs question, recommend and byDefault as text');
    assert.equal(parseCard({ ...TEST_CARD, options: 'Basic | Pro' }), 'card options is not a list of texts');
    assert.equal(parseCard({ ...TEST_CARD, options: ['Basic', 2] }), 'card options is not a list of texts');
    assert.deepEqual(parseCard({ ...TEST_CARD, whyAsk: WHY_ASK }), { ...TEST_CARD, whyAsk: WHY_ASK });
    assert.equal(parseCard({ ...TEST_CARD, whyAsk: 7 }), 'card whyAsk is not text');
  });

  it('prints the question, each option numbered, the recommendation and the default', () => {
    assert.deepEqual(cardTexts(TEST_CARD), [TEST_CARD.question, ...TEST_CARD.options, TEST_CARD.recommend, TEST_CARD.byDefault]);
    assert.deepEqual(cardLines(TEST_CARD, '  '), [
      '  decide: Which pricing tier ships first',
      '    1. Basic at 9 dollars a month',
      '    2. Pro at 29 dollars a month',
      '  recommended: Basic, the cheaper launch',
      '  with no answer: Basic ships on the due date',
    ]);
  });

  it('prints why the owner is asked under the question, and drops it on request', () => {
    const asked = { ...TEST_CARD, whyAsk: WHY_ASK };
    assert.deepEqual(cardTexts(asked), [TEST_CARD.question, WHY_ASK, ...TEST_CARD.options, TEST_CARD.recommend, TEST_CARD.byDefault]);
    assert.deepEqual(cardLines(asked, '  ').slice(0, 2), ['  decide: Which pricing tier ships first', `  why asked: ${WHY_ASK}`]);
    assert.deepEqual(withoutWhyAsk(asked), TEST_CARD);
  });
});
