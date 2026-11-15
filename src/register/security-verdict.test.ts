import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TEST_CARD, TEST_OWNER_CARD } from '../testing/card.ts';
import { parseSecurityVerdictPin, verdictIsCurrent, verdictReadOf, type SecurityVerdictPin } from './security-verdict.ts';

const PIN: SecurityVerdictPin = { text: 'Pass: read-only grant, no secret', read: verdictReadOf(TEST_CARD) };

describe('verdictReadOf and verdictIsCurrent: a verdict binds to the card parts it read (T2761)', () => {
  it('reads the question, options and recommendation, and none of the parts that say when or why the owner is asked', () => {
    assert.deepEqual(verdictReadOf(TEST_OWNER_CARD), { question: TEST_CARD.question, options: TEST_CARD.options, recommend: TEST_CARD.recommend });
  });

  it('holds while the card asks the same, its default, gate or why-ask changed or not', () => {
    assert.equal(verdictIsCurrent(PIN, TEST_CARD), true);
    assert.equal(verdictIsCurrent(PIN, { ...TEST_OWNER_CARD, byDefault: 'Nothing ships on the due date', whyAsk: 'only the owner sees the bill' }), true);
  });

  it('goes stale on a changed question, recommendation, option, option order or option count', () => {
    const [first = '', second = ''] = TEST_CARD.options;
    const edits = [
      { ...TEST_CARD, question: `${TEST_CARD.question} now` },
      { ...TEST_CARD, recommend: 'Pro, the richer launch' },
      { ...TEST_CARD, options: [first, `${second} with a discount`] },
      { ...TEST_CARD, options: [second, first] },
      { ...TEST_CARD, options: [first, second, 'Both at once'] },
    ];
    for (const card of edits) {
      assert.equal(verdictIsCurrent(PIN, card), false, JSON.stringify(card));
    }
  });
});

describe('parseSecurityVerdictPin: the verdict an update line gives (T2761)', () => {
  it('reads a well-formed pin', () => {
    assert.deepEqual(parseSecurityVerdictPin(JSON.parse(JSON.stringify(PIN))), PIN);
  });

  it('refuses a pin with no text, a blank one, no read parts or a read part of the wrong type', () => {
    const bads: unknown[] = [
      'pass',
      { read: PIN.read },
      { text: ' ', read: PIN.read },
      { text: 'pass' },
      { text: 'pass', read: { ...PIN.read, question: 7 } },
      { text: 'pass', read: { ...PIN.read, options: 'one' } },
      { text: 'pass', read: { ...PIN.read, options: ['one', 2] } },
      { text: 'pass', read: { question: 'q', options: [] } },
    ];
    for (const bad of bads) {
      const parsed = parseSecurityVerdictPin(bad);
      assert.equal(typeof parsed, 'string', JSON.stringify(bad));
      assert.match(String(parsed), /^bad security verdict /);
    }
  });
});
