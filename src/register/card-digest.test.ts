import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { TEST_CARD } from '../testing/card.ts';
import type { DecisionCard } from './card.ts';
import { cardDigest, isCardDigest, type DigestedCard } from './card-digest.ts';

/** node:crypto's digest of the bytes cardDigest reads, the value it must match. */
function expected(card: DigestedCard): string {
  return createHash('sha256').update(JSON.stringify([card.question, [...card.options], card.recommend]), 'utf8').digest('hex');
}

describe('cardDigest (#1751 review)', () => {
  it("matches node:crypto's SHA-256 over the card's question, options and recommendation", () => {
    assert.equal(cardDigest(TEST_CARD), expected(TEST_CARD));
    assert.match(cardDigest(TEST_CARD), /^[0-9a-f]{64}$/);
  });

  it('matches across the padding edges, multi-block messages and non-ASCII text', () => {
    // The JSON wrapper `["","",...]` adds bytes, so walk the question length over the 55, 56 and 64 byte edges.
    for (let length = 0; length <= 200; length++) {
      const card = { question: 'q'.repeat(length), options: [], recommend: '' };
      assert.equal(cardDigest(card), expected(card), `question of ${length} characters`);
    }
    const wide = { question: 'Ship to Tel Aviv? שלום, 日本, emoji 🚀', options: ['ä', 'ß'.repeat(300)], recommend: '"quoted" \\ back' };
    assert.equal(cardDigest(wide), expected(wide));
  });

  it('changes when the question, an option, their order or the recommendation changes, and not for the other parts', () => {
    const base = cardDigest(TEST_CARD);
    assert.notEqual(cardDigest({ ...TEST_CARD, question: `${TEST_CARD.question}?` }), base);
    assert.notEqual(cardDigest({ ...TEST_CARD, options: [...TEST_CARD.options].reverse() }), base);
    assert.notEqual(cardDigest({ ...TEST_CARD, recommend: 'the other one' }), base);
    // The JSON array keeps the parts apart: moving text between two of them gives another digest.
    assert.notEqual(cardDigest({ question: 'ab', options: ['c'], recommend: '' }), cardDigest({ question: 'a', options: ['bc'], recommend: '' }));
    const otherDefault: DecisionCard = { ...TEST_CARD, byDefault: 'something else', gate: 'budget' };
    assert.equal(cardDigest(otherDefault), base);
  });

  it('knows the shape of a digest', () => {
    assert.equal(isCardDigest(cardDigest(TEST_CARD)), true);
    assert.equal(isCardDigest(cardDigest(TEST_CARD).toUpperCase()), true);
    for (const bad of ['', 'abc', 'g'.repeat(64), 'a'.repeat(63), 'a'.repeat(65)]) {
      assert.equal(isCardDigest(bad), false, bad);
    }
  });
});
