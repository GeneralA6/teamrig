import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { testConfig } from '../testing/config.ts';
import { dailyBudgetOf, type BudgetSplit, type TeamsOnAccount } from './parts.ts';
import { fundByPriority, fundForDay, isPaused, isShortDay, pausableOf, type DayPlan } from './pause.ts';
import type { WorkByPriority } from './work.ts';

const IDS = ['lead', 'alpha', 'bravo'];

/** Each session's queued work, as its weights by priority id. */
function workOf(entries: Readonly<Record<string, Readonly<Record<number, number>>>>): ReadonlyMap<string, WorkByPriority> {
  return new Map(Object.entries(entries).map(([id, byPriority]) => [id, new Map(Object.entries(byPriority).map(([priority, weight]) => [Number(priority), weight]))]));
}

/** The team `app`, of weight 10: the lead 1, alpha 5 at p1, bravo 3 at p3 and charlie 1 with no queued work, all but the lead pausable. */
function app(extra: Partial<BudgetSplit> = {}): BudgetSplit {
  return {
    team: 'app',
    ids: ['lead', 'alpha', 'bravo', 'charlie'],
    sessions: {},
    leads: {},
    work: workOf({ alpha: { 1: 5 }, bravo: { 3: 3 } }),
    lifted: new Map(),
    liftedGroups: new Map(),
    pausable: new Set(['alpha', 'bravo', 'charlie']),
    funded: new Map(),
    ...extra,
  };
}

/** A split's funded parts, rounded clear of float noise. */
function partsOf(split: BudgetSplit): [string, number][] {
  return [...split.funded].map(([id, part]) => [id, Math.round(part * 1e9) / 1e9]);
}

/** The funded parts of `split` alone on its account on `day`. */
function fundedOf(split: BudgetSplit, day: DayPlan): [string, number][] {
  return partsOf(fundByPriority({ split, others: [] }, day).split);
}

function near(actual: number | undefined, expected: number, message: string): void {
  assert.ok(actual !== undefined && Math.abs(actual - expected) < 1e-9, `${message}: ${actual} is not ${expected}`);
}

describe('pausableOf', () => {
  it('pauses no session while budget.pauseByPriority is off', () => {
    assert.deepEqual([...pausableOf(testConfig({ roles: { lead: 'lead', coordinatorOwner: 'alpha' } }), 'app', IDS)], []);
  });

  it('may pause every session but the lead and the coordinator owner the team holds', () => {
    const config = testConfig({ budget: { pauseByPriority: true }, roles: { lead: 'lead', coordinatorOwner: 'alpha' } });
    assert.deepEqual([...pausableOf(config, 'app', IDS)], ['bravo']);
  });

  it('may pause a session of the team that shares its id with the coordinator owner of a team above', () => {
    const config = testConfig({ budget: { pauseByPriority: true }, roles: { lead: 'lead', coordinatorOwner: 'root/alpha' } });
    assert.deepEqual([...pausableOf(config, 'app', IDS)], ['alpha', 'bravo']);
  });

  it('keeps only the lead on a team with no coordinator owner', () => {
    assert.deepEqual([...pausableOf(testConfig({ budget: { pauseByPriority: true } }), 'app', IDS)], ['alpha', 'bravo']);
  });
});

describe('isShortDay', () => {
  it('is short when what is left of the week gives the day less than the pace line plans for it', () => {
    assert.deepEqual([9.9, 10, 12].map((allowancePct) => isShortDay({ allowancePct, plannedPct: 10 })), [true, false, false]);
  });

  it('is never short on a day the pace line plans nothing for, as past the pace end', () => {
    assert.equal(isShortDay({ allowancePct: 0, plannedPct: 0 }), false);
  });
});

describe('fundByPriority', () => {
  it('funds every session whole on a day that is not short', () => {
    for (const day of [{ allowancePct: 10, plannedPct: 10 }, { allowancePct: 14, plannedPct: 10 }, { allowancePct: 1, plannedPct: 0 }]) {
      assert.deepEqual(fundedOf(app(), day), [], JSON.stringify(day));
    }
  });

  it('funds the kept sessions first, then the work p0 first, and pauses the sessions the day does not reach', () => {
    assert.deepEqual(fundedOf(app(), { allowancePct: 6, plannedPct: 10 }), [['alpha', 1], ['bravo', 0], ['charlie', 0]]);
  });

  it('funds the priority the funding runs out in in part, and the idle sessions last', () => {
    assert.deepEqual(fundedOf(app(), { allowancePct: 7, plannedPct: 10 }), [['alpha', 1], ['bravo', 0.333333333], ['charlie', 0]]);
    assert.deepEqual(fundedOf(app(), { allowancePct: 9.5, plannedPct: 10 }), [['alpha', 1], ['bravo', 1], ['charlie', 0.5]]);
  });

  it('funds a session by the part of its work the funding reaches', () => {
    const split = app({ work: workOf({ alpha: { 0: 6, 3: 3 }, bravo: { 3: 3 } }) });
    assert.deepEqual(fundedOf(split, { allowancePct: 10, plannedPct: 14 }), [['alpha', 0.833333333], ['bravo', 0.5], ['charlie', 0]]);
  });

  it("weighs each session's work by its share", () => {
    assert.deepEqual(fundedOf(app({ sessions: { alpha: { share: 2 } } }), { allowancePct: 11, plannedPct: 15 }), [['alpha', 1], ['bravo', 0], ['charlie', 0]]);
  });

  it("gives a funded session the part the pace line's rate gives it while no lift is in force", () => {
    const { split } = fundByPriority({ split: app(), others: [] }, { allowancePct: 6, plannedPct: 10 });
    near(dailyBudgetOf(6, 'lead', split), 1, 'the lead, 10 x 1/10');
    near(dailyBudgetOf(6, 'alpha', split), 5, 'alpha, 10 x 5/10');
    near(dailyBudgetOf(6, 'bravo', split), 0, 'bravo, paused');
  });

  it('keeps a lifted session and the sessions of a lifted group whole, and pays them first', () => {
    const split = app({
      ids: ['lead', 'alpha', 'bravo', 'charlie', 'delta'],
      leads: { alpha: ['bravo'] },
      work: workOf({ delta: { 2: 4 } }),
      lifted: new Map([['charlie', 20]]),
      liftedGroups: new Map([['alpha', 40]]),
      pausable: new Set(['alpha', 'bravo', 'charlie', 'delta']),
    });
    assert.deepEqual(fundedOf(split, { allowancePct: 4, plannedPct: 10 }), [['delta', 0]]);
    assert.deepEqual(fundedOf(split, { allowancePct: 6, plannedPct: 10 }), [['delta', 0.2]]);
  });

  it('never cuts a session its team may not pause', () => {
    assert.deepEqual(fundedOf(app({ pausable: new Set() }), { allowancePct: 6, plannedPct: 10 }), []);
  });

  it('funds the teams on one account in one priority order', () => {
    const teams: TeamsOnAccount = {
      split: app({ ids: ['lead', 'alpha'], work: workOf({ alpha: { 1: 5 } }), pausable: new Set(['alpha']) }),
      others: [app({ team: 'web', ids: ['boss', 'echo'], work: workOf({ echo: { 0: 6 } }), pausable: new Set(['echo']) })],
    };
    const funded = fundByPriority(teams, { allowancePct: 8, plannedPct: 13 });
    assert.deepEqual([partsOf(funded.split), funded.others.map(partsOf)], [[['alpha', 0]], [[['echo', 1]]]]);
  });
});

describe('fundForDay', () => {
  it("funds the teams for the week's day, and leaves them as they are while its allowance or plan is unknown", () => {
    const teams: TeamsOnAccount = { split: app(), others: [] };
    assert.deepEqual(partsOf(fundForDay(teams, { allowancePct: 6, plannedPct: 10 }).split), [['alpha', 1], ['bravo', 0], ['charlie', 0]]);
    assert.equal(fundForDay(teams, { allowancePct: undefined, plannedPct: 10 }), teams);
    assert.equal(fundForDay(teams, { allowancePct: 6, plannedPct: undefined }), teams);
  });
});

describe('isPaused', () => {
  it('pauses a session none of the day reaches, and no other', () => {
    const split = app({ funded: new Map([['alpha', 0], ['bravo', 0.5]]) });
    assert.deepEqual(['alpha', 'bravo', 'charlie'].map((id) => isPaused(split, id)), [true, false, false]);
  });
});
