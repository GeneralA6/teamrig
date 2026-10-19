import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SessionBudget } from '../config/types.ts';
import type { Lift } from './lift.ts';
import { addedSessionPct, dailyBudgetOf, liftedParts, sessionBudgetPct, type BudgetSplit } from './parts.ts';

const IDS = ['lead', 'alpha', 'bravo'];
const NOW = Date.parse('2030-01-08T10:00:00Z');
const MINUTE = 60_000;

function split(sessions: Readonly<Record<string, SessionBudget>> = {}, extra: Partial<BudgetSplit> = {}): BudgetSplit {
  return { ids: IDS, sessions, work: new Map(), lifted: new Map(), ...extra };
}

function lift(overrides: Partial<Lift> = {}): Lift {
  return { session: 'alpha', partPct: 50, stopPct: 97, endsAt: NOW + 60 * MINUTE, reserve: false, quietHoursExempt: true, reason: 'release', by: 'lead', at: NOW - MINUTE, ...overrides };
}

describe('sessionBudgetPct', () => {
  it('splits the allowance evenly by default', () => {
    assert.equal(sessionBudgetPct(9, 'alpha', split()), 3);
  });

  it('splits by share', () => {
    assert.equal(sessionBudgetPct(8, 'alpha', split({ alpha: { share: 2 } })), 4);
    assert.equal(sessionBudgetPct(8, 'bravo', split({ alpha: { share: 2 }, bravo: { share: 0 } })), 0);
  });

  it('splits by queued work times share, a session with none counting 1', () => {
    const work = new Map([['alpha', 6], ['bravo', 2]]);
    // Weights lead 1, alpha 6, bravo 2: 9 in all.
    assert.equal(sessionBudgetPct(9, 'alpha', split({}, { work })), 6);
    assert.equal(sessionBudgetPct(9, 'lead', split({}, { work })), 1);
    assert.equal(sessionBudgetPct(12, 'bravo', split({ bravo: { share: 2 } }, { work })), 12 * (4 / 11));
  });

  it('gives a lifted session its part of the allowance and splits the rest among the others', () => {
    const lifted = new Map([['alpha', 50]]);
    assert.equal(sessionBudgetPct(12, 'alpha', split({}, { lifted })), 6);
    assert.equal(sessionBudgetPct(12, 'bravo', split({}, { lifted })), 3);
    assert.equal(sessionBudgetPct(12, 'bravo', split({}, { lifted: new Map([['alpha', 60], ['lead', 40]]) })), 0);
  });

  it('gives a fixed daily % as is and splits what is left among the others', () => {
    const sessions = { bravo: { share: 1, dailyPct: 1.5 } };
    assert.equal(sessionBudgetPct(9, 'bravo', split(sessions)), 1.5);
    assert.equal(sessionBudgetPct(9, 'alpha', split(sessions)), 3.75);
    assert.equal(sessionBudgetPct(1, 'alpha', split({ bravo: { share: 1, dailyPct: 2 } })), 0);
  });

  it('gives 0 when no session takes a share', () => {
    assert.equal(sessionBudgetPct(9, 'alpha', { ...split({ alpha: { share: 0 } }), ids: ['alpha'] }), 0);
  });
});

describe('dailyBudgetOf', () => {
  it("is the session's part of a known allowance, else its fixed daily %, else unknown", () => {
    assert.equal(dailyBudgetOf(9, 'alpha', split()), 3);
    assert.equal(dailyBudgetOf(undefined, 'alpha', split({ alpha: { share: 1, dailyPct: 2 } })), 2);
    assert.equal(dailyBudgetOf(undefined, 'alpha', split()), undefined);
  });
});

describe('liftedParts', () => {
  it("maps each session's lift in force to its part", () => {
    const lifts = [lift(), lift({ session: 'bravo', partPct: 20, endsAt: NOW }), lift({ session: 'lead', partPct: 10, stopPct: 50 })];
    assert.deepEqual([...liftedParts(lifts, IDS, NOW, 57)], [['alpha', 50]]);
    assert.deepEqual([...liftedParts(lifts, IDS, NOW, undefined)], [['lead', 10], ['alpha', 50]]);
  });
});

describe('addedSessionPct', () => {
  it('gives one more session at the default weight its part beside the shares, queued work and lifts', () => {
    const weighted = split({ lead: { share: 2 } }, { work: new Map([['alpha', 3]]) });
    assert.equal(addedSessionPct(10, weighted), 10 / 7, 'weights lead 2, alpha 3, bravo 1, the added session 1');
    assert.equal(addedSessionPct(10, { ...weighted, lifted: new Map([['bravo', 30]]) }), 7 / 6, "bravo's lift takes 30% first");
    assert.equal(addedSessionPct(9, split()), 9 / 4);
  });
});
