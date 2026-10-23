import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SESSION_SHARE } from '../config/defaults.ts';
import type { SessionBudget } from '../config/types.ts';
import type { Lift } from './lift.ts';
import { addedSessionPct, dailyBudgetOf, liftedParts, partOf, sessionNodesOf, type BudgetSplit, type SplitNode } from './parts.ts';

const IDS = ['lead', 'alpha', 'bravo'];
const NOW = Date.parse('2030-01-08T10:00:00Z');
const MINUTE = 60_000;

function split(sessions: Readonly<Record<string, SessionBudget>> = {}, extra: Partial<BudgetSplit> = {}): BudgetSplit {
  return { ids: IDS, sessions, work: new Map(), lifted: new Map(), ...extra };
}

function lift(overrides: Partial<Lift> = {}): Lift {
  return { session: 'alpha', partPct: 50, stopPct: 97, endsAt: NOW + 60 * MINUTE, reserve: false, quietHoursExempt: true, reason: 'release', by: 'lead', at: NOW - MINUTE, ...overrides };
}

/** The flat split `dailyBudgetOf` replaced (teamrig 0.152.0 `sessionBudgetPct`), kept to pin the tree to it. */
function flatSplitPct(allowancePct: number, session: string, split: BudgetSplit): number {
  const weightOf = (id: string): number => (split.sessions[id]?.share ?? DEFAULT_SESSION_SHARE) * Math.max(1, split.work.get(id) ?? 0);
  const liftedPart = split.lifted.get(session);
  if (liftedPart !== undefined) {
    return (allowancePct * liftedPart) / 100;
  }
  let liftedPct = 0;
  let weights = 0;
  for (const id of split.ids) {
    const part = split.lifted.get(id);
    if (part === undefined) {
      weights += weightOf(id);
    } else {
      liftedPct += part;
    }
  }
  const rest = (allowancePct * Math.max(0, 100 - liftedPct)) / 100;
  return weights > 0 ? (rest * weightOf(session)) / weights : 0;
}

/** A fixed pseudo-random sequence in [0, 1), so the regression cases are the same on every run. */
function sequence(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

describe('dailyBudgetOf', () => {
  it('splits the allowance evenly by default', () => {
    assert.equal(dailyBudgetOf(9, 'alpha', split()), 3);
  });

  it('splits by share', () => {
    assert.equal(dailyBudgetOf(8, 'alpha', split({ alpha: { share: 2 } })), 4);
    assert.equal(dailyBudgetOf(8, 'bravo', split({ alpha: { share: 2 }, bravo: { share: 0 } })), 0);
  });

  it('splits by queued work times share, a session with none counting 1', () => {
    const work = new Map([['alpha', 6], ['bravo', 2]]);
    // Weights lead 1, alpha 6, bravo 2: 9 in all.
    assert.equal(dailyBudgetOf(9, 'alpha', split({}, { work })), 6);
    assert.equal(dailyBudgetOf(9, 'lead', split({}, { work })), 1);
    assert.equal(dailyBudgetOf(12, 'bravo', split({ bravo: { share: 2 } }, { work })), 12 * (4 / 11));
  });

  it('gives a lifted session its part of the allowance and splits the rest among the others', () => {
    const lifted = new Map([['alpha', 50]]);
    assert.equal(dailyBudgetOf(12, 'alpha', split({}, { lifted })), 6);
    assert.equal(dailyBudgetOf(12, 'bravo', split({}, { lifted })), 3);
    assert.equal(dailyBudgetOf(12, 'bravo', split({}, { lifted: new Map([['alpha', 60], ['lead', 40]]) })), 0);
  });

  it('gives 0 when no session takes a share', () => {
    assert.equal(dailyBudgetOf(9, 'alpha', { ...split({ alpha: { share: 0 } }), ids: ['alpha'] }), 0);
  });

  it("is unknown while the team's allowance is, or for a session the split does not hold", () => {
    assert.equal(dailyBudgetOf(undefined, 'alpha', split({ alpha: { share: 2 } })), undefined);
    assert.equal(dailyBudgetOf(9, 'charlie', split()), undefined);
  });

  it('gives every session of a one-team split the part the flat split gave it', () => {
    const next = sequence(940);
    const ids = ['lead', 'alpha', 'bravo', 'charlie', 'delta'];
    for (let round = 0; round < 500; round++) {
      const sessions: Record<string, SessionBudget> = {};
      const work = new Map<string, number>();
      const lifted = new Map<string, number>();
      for (const id of ids) {
        if (next() < 0.5) {
          sessions[id] = { share: Math.floor(next() * 4) + (next() < 0.5 ? 0.5 : 0) };
        }
        if (next() < 0.6) {
          work.set(id, Math.floor(next() * 12));
        }
        if (next() < 0.15) {
          lifted.set(id, Math.floor(next() * 70) + 5);
        }
      }
      const each: BudgetSplit = { ids, sessions, work, lifted };
      const allowancePct = next() * 20;
      for (const id of ids) {
        assert.equal(dailyBudgetOf(allowancePct, id, each), flatSplitPct(allowancePct, id, each), `round ${round}, ${id}`);
      }
    }
  });
});

describe('partOf', () => {
  const leaf = (id: string, weight: number, liftedPct?: number): SplitNode => ({ id, weight, liftedPct });

  it('splits each level by weight, a group weighing what its nodes weigh together', () => {
    const nodes: SplitNode[] = [leaf('lead', 1), { id: 'ops', liftedPct: undefined, nodes: [leaf('alpha', 2), leaf('bravo', 1)] }];
    assert.equal(partOf(12, nodes, ['ops']), 9);
    assert.equal(partOf(12, nodes, ['ops', 'alpha']), 6);
    assert.equal(partOf(12, nodes, ['lead']), 3);
  });

  it("gives a lifted group its lift's part, splits it among its nodes, and the rest among its siblings", () => {
    const nodes: SplitNode[] = [leaf('lead', 1), leaf('alpha', 3), { id: 'ops', liftedPct: 50, nodes: [leaf('bravo', 1), leaf('charlie', 1, 20)] }];
    assert.equal(partOf(20, nodes, ['ops']), 10);
    assert.equal(partOf(20, nodes, ['ops', 'charlie']), 2);
    assert.equal(partOf(20, nodes, ['ops', 'bravo']), 8);
    assert.equal(partOf(20, nodes, ['alpha']), 7.5);
  });

  it('is undefined for a path no node is at', () => {
    const nodes: SplitNode[] = [leaf('lead', 1), { id: 'ops', liftedPct: undefined, nodes: [leaf('alpha', 1)] }];
    assert.equal(partOf(12, nodes, ['ops', 'bravo']), undefined);
    assert.equal(partOf(12, nodes, ['lead', 'alpha']), undefined);
    assert.equal(partOf(12, nodes, []), undefined);
  });
});

describe('sessionNodesOf', () => {
  it("weighs each session by its share times its queued work, at least 1, with its lift's part", () => {
    const nodes = sessionNodesOf(split({ alpha: { share: 2 } }, { work: new Map([['alpha', 3], ['bravo', 0]]), lifted: new Map([['bravo', 30]]) }));
    assert.deepEqual(nodes, [
      { id: 'lead', liftedPct: undefined, weight: 1 },
      { id: 'alpha', liftedPct: undefined, weight: 6 },
      { id: 'bravo', liftedPct: 30, weight: 1 },
    ]);
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
