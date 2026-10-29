import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatWeight, helperDefaultClause, helperLaunchReminder } from './helper-default.ts';

describe('helper default', () => {
  it('prints the weight with at most two decimals', () => {
    assert.equal(formatWeight(2.15), '2.15');
    assert.equal(formatWeight(2), '2');
    assert.equal(formatWeight(1.23456), '1.23');
    assert.equal(formatWeight(0.1), '0.1');
  });

  it('names the factor and its key, and keeps helpers to parallel work or a review, when a helper costs more than the session', () => {
    assert.equal(
      helperDefaultClause(2.15),
      "a helper's tokens cost 2.15x yours [budget.subagentWeight], so start one only for parallel work or an independent review," +
        ' never to save tokens or for a build or test you wait on',
    );
    assert.doesNotMatch(helperDefaultClause(2.15), /keeps far more/);
  });

  it('asks only that a helper keep more out than it uses when it costs no more than the session', () => {
    for (const weight of [1, 0.5]) {
      const clause = helperDefaultClause(weight);
      assert.match(clause, /^start a helper only when it keeps far more tokens out of your context than it uses or truly runs in parallel/);
      assert.doesNotMatch(clause, /subagentWeight/);
    }
  });

  it('says the default at a helper launch, for the next one', () => {
    assert.equal(
      helperLaunchReminder(2.15),
      `teamrig rule 8: work in your own session: ${helperDefaultClause(2.15)}. Weigh the next helper the same way.`,
    );
    assert.doesNotMatch(helperLaunchReminder(2.15), /pays/);
  });
});
