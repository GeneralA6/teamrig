import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SESSION_SHARE } from '../config/defaults.ts';
import type { SessionBudget } from '../config/types.ts';
import type { Lift } from './lift.ts';
import { addedSessionPct, budgetSplitOf, dailyBudgetOf, groupPartsOf, liftPlaceOf, partOf, teamPartOf, teamShareOf, teamTreeOf, type BudgetSplit, type GroupPart, type SplitNode } from './parts.ts';
import { workWeightOf, type WorkByPriority } from './work.ts';

const IDS = ['lead', 'alpha', 'bravo'];
const NOW = Date.parse('2030-01-08T10:00:00Z');
const MINUTE = 60_000;

function split(sessions: Readonly<Record<string, SessionBudget>> = {}, extra: Partial<BudgetSplit> = {}): BudgetSplit {
  return { team: 'app', ids: IDS, sessions, leads: {}, work: new Map(), lifted: new Map(), liftedGroups: new Map(), ...extra };
}

/** Each session's queued work as one weight, all of it at p1. */
function workOf(weights: Readonly<Record<string, number>>): ReadonlyMap<string, WorkByPriority> {
  return new Map(Object.entries(weights).map(([id, weight]) => [id, new Map([[1, weight]])]));
}

/** Another team on the account, its sessions at the default share with no queued work unless `extra` says so. */
function otherTeam(team: string, ids: readonly string[], extra: Partial<BudgetSplit> = {}): BudgetSplit {
  return { team, ids, sessions: {}, leads: {}, work: new Map(), lifted: new Map(), liftedGroups: new Map(), ...extra };
}

/** A team led as lead > alpha > bravo > charlie, with delta beside alpha under the lead, every session at weight 1. */
function nested(extra: Partial<BudgetSplit> = {}): BudgetSplit {
  return split({}, { ids: ['lead', 'alpha', 'bravo', 'charlie', 'delta'], leads: { alpha: ['bravo'], bravo: ['charlie'] }, ...extra });
}

function lift(overrides: Partial<Lift> = {}): Lift {
  return { session: 'alpha', group: false, partPct: 50, stopPct: 97, endsAt: NOW + 60 * MINUTE, reserve: false, quietHoursExempt: true, reason: 'release', by: 'lead', at: NOW - MINUTE, ...overrides };
}

/** Within a rounding error of `expected`: a tree splits level by level, so its parts can be an ulp off a flat split's. */
function near(actual: number | undefined, expected: number, message: string): void {
  assert.ok(actual !== undefined && Math.abs(actual - expected) < 1e-9, `${message}: ${actual} is not ${expected}`);
}

/** The flat split `dailyBudgetOf` replaced (teamrig 0.152.0 `sessionBudgetPct`), kept to pin the tree to it. */
function flatSplitPct(allowancePct: number, session: string, split: BudgetSplit): number {
  const weightOf = (id: string): number => (split.sessions[id]?.share ?? DEFAULT_SESSION_SHARE) * Math.max(1, workWeightOf(split.work.get(id)));
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

/** Random shares, queued work and lifts (on the `liftable` sessions only) for `ids`, drawn in the first regression's order. */
function randomParts(next: () => number, ids: readonly string[], liftable: (id: string) => boolean): Pick<BudgetSplit, 'sessions' | 'work' | 'lifted'> {
  const sessions: Record<string, SessionBudget> = {};
  const work = new Map<string, WorkByPriority>();
  const lifted = new Map<string, number>();
  for (const id of ids) {
    if (next() < 0.5) {
      sessions[id] = { share: Math.floor(next() * 4) + (next() < 0.5 ? 0.5 : 0) };
    }
    if (next() < 0.6) {
      work.set(id, new Map([[1, Math.floor(next() * 12)]]));
    }
    if (liftable(id) && next() < 0.15) {
      lifted.set(id, Math.floor(next() * 70) + 5);
    }
  }
  return { sessions, work, lifted };
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
    const work = workOf({ alpha: 6, bravo: 2 });
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
      const each: BudgetSplit = { team: 'app', ids, ...randomParts(next, ids, () => true), leads: {}, liftedGroups: new Map() };
      const allowancePct = next() * 20;
      for (const id of ids) {
        assert.equal(dailyBudgetOf(allowancePct, id, each), flatSplitPct(allowancePct, id, each), `round ${round}, ${id}`);
        assert.equal(dailyBudgetOf(allowancePct, id, each, []), flatSplitPct(allowancePct, id, each), `round ${round}, ${id}, no other team`);
      }
    }
  });

  it('gives every session of a lead tree the flat split part while no group and no session inside one is lifted', () => {
    const next = sequence(784);
    const ids = ['lead', 'alpha', 'bravo', 'charlie', 'delta', 'echo'];
    for (let round = 0; round < 500; round++) {
      // Each session after alpha is listed, half the time, by a session before it other than the lead: trees of any depth.
      const leads: Record<string, string[]> = {};
      for (const [index, id] of ids.entries()) {
        const leader = index >= 2 && next() < 0.5 ? ids[1 + Math.floor(next() * (index - 1))] : undefined;
        if (leader !== undefined) {
          (leads[leader] ??= []).push(id);
        }
      }
      const inGroups = new Set([...Object.keys(leads), ...Object.values(leads).flat()]);
      const each: BudgetSplit = { team: 'app', ids, ...randomParts(next, ids, (id) => !inGroups.has(id)), leads, liftedGroups: new Map() };
      const allowancePct = next() * 20;
      for (const id of ids) {
        near(dailyBudgetOf(allowancePct, id, each), flatSplitPct(allowancePct, id, each), `round ${round}, ${id}, leads ${JSON.stringify(leads)}`);
      }
    }
  });

  it("gives a lifted group its lift's part of its parent's budget, split among its sessions, and the rest to its siblings", () => {
    const team = split({}, { ids: ['lead', 'alpha', 'bravo', 'charlie'], leads: { alpha: ['bravo', 'charlie'] }, liftedGroups: new Map([['alpha', 60]]) });
    // The group (alpha, bravo, charlie) takes 60% of 10; the lead the 40% left.
    near(dailyBudgetOf(10, 'alpha', team), 2, 'alpha');
    near(dailyBudgetOf(10, 'charlie', team), 2, 'charlie');
    near(dailyBudgetOf(10, 'lead', team), 4, 'lead');
  });

  it("gives a session lifted inside a group its lift's part of the group's budget, not of the team's", () => {
    const team = split({}, { ids: ['lead', 'alpha', 'bravo', 'charlie'], leads: { alpha: ['bravo', 'charlie'] }, lifted: new Map([['bravo', 50]]) });
    // The group weighs 3 of 4: 7.5 of 10; bravo takes half of it, alpha and charlie split the rest.
    near(dailyBudgetOf(10, 'bravo', team), 3.75, 'bravo');
    near(dailyBudgetOf(10, 'alpha', team), 1.875, 'alpha');
    near(dailyBudgetOf(10, 'lead', team), 2.5, 'the lead keeps its part');
  });

  it("splits a nested sub-lead's group out of the group that lists it", () => {
    const team = nested({ liftedGroups: new Map([['bravo', 50]]) });
    // Alpha's group weighs 3 of 5: 6 of 10; bravo's group (bravo, charlie) takes half of it, alpha's own leaf the rest.
    near(dailyBudgetOf(10, 'alpha', team), 3, 'alpha');
    near(dailyBudgetOf(10, 'bravo', team), 1.5, 'bravo');
    near(dailyBudgetOf(10, 'charlie', team), 1.5, 'charlie');
    near(dailyBudgetOf(10, 'delta', team), 2, 'delta');
  });

  it('splits the day among the sessions no sub-lead off the roster or in a loop of listings leaves out', () => {
    const offRoster = split({}, { leads: { zulu: ['alpha'] } });
    assert.equal(dailyBudgetOf(9, 'alpha', offRoster), 3, "an off-roster sub-lead's members are the lead's");
    const loop = split({}, { ids: ['lead', 'alpha', 'bravo', 'charlie'], leads: { alpha: ['bravo'], bravo: ['alpha'] } });
    assert.equal(dailyBudgetOf(10, 'alpha', loop), undefined);
    assert.equal(dailyBudgetOf(10, 'bravo', loop), undefined);
    assert.equal(dailyBudgetOf(10, 'charlie', loop), 5);
  });

  it('gives every session on the account the same part at equal weights, whichever team it is on', () => {
    const web = otherTeam('web', ['lead', 'front']);
    assert.equal(dailyBudgetOf(10, 'alpha', split(), [web]), 2);
    assert.equal(dailyBudgetOf(10, 'front', web, [split()]), 2);
  });

  it("splits the team's part among its sessions by share, queued work and lifts, as it split the whole day", () => {
    const app = split({ alpha: { share: 2 } });
    const web = otherTeam('web', ['lead', 'front'], { work: workOf({ front: 4 }) });
    // Team weights app 4 (lead 1, alpha 2, bravo 1) and web 5 (lead 1, front 4): parts 8 and 10 of 18.
    assert.equal(dailyBudgetOf(18, 'alpha', app, [web]), 4);
    assert.equal(dailyBudgetOf(18, 'bravo', app, [web]), 2);
    assert.equal(dailyBudgetOf(18, 'front', web, [app]), 8);
  });

  it("gives a lifted session its lift's part of its team's part, not of the account's day", () => {
    const lifted = new Map([['alpha', 50]]);
    const web = otherTeam('web', ['lead', 'front']);
    // App's part is 3 of 5 weights, 6; alpha's lift takes half of it and lead and bravo split the rest.
    assert.equal(dailyBudgetOf(10, 'alpha', split({}, { lifted }), [web]), 3);
    assert.equal(dailyBudgetOf(10, 'bravo', split({}, { lifted }), [web]), 1.5);
    assert.equal(dailyBudgetOf(10, 'front', web, [split({}, { lifted })]), 2, 'a lift moves nothing between the teams');
  });

  it("splits a team's part down its own lead tree beside another team, a group lift moving nothing between the teams", () => {
    const app = split({}, { leads: { alpha: ['bravo'] }, liftedGroups: new Map([['alpha', 50]]) });
    const web = otherTeam('web', ['lead', 'ops', 'front'], { leads: { ops: ['front'] } });
    // Each team weighs 3: 6 of 12. Alpha's group takes half of app's, bravo half the group's; ops's group weighs 2 of 3.
    near(dailyBudgetOf(12, 'bravo', app, [web]), 1.5, 'bravo');
    near(dailyBudgetOf(12, 'lead', app, [web]), 3, 'lead');
    near(dailyBudgetOf(12, 'front', web, [app]), 2, 'front');
  });

  it('is unknown for a session only another team holds', () => {
    assert.equal(dailyBudgetOf(10, 'front', split(), [otherTeam('web', ['front'])]), undefined);
  });
});

describe('groupPartsOf', () => {
  /** The parts without their budgets, which `near` checks: a tree's parts can be an ulp off the sums they pin. */
  const shapes = (parts: readonly GroupPart[]): Omit<GroupPart, 'budgetPct'>[] => parts.map(({ id, sessions, liftedPct }) => ({ id, sessions, liftedPct }));

  it("gives each group, before the groups under it, its sessions' daily budgets summed while nothing is lifted", () => {
    const team = nested();
    const parts = groupPartsOf(10, team);
    assert.deepEqual(shapes(parts), [
      { id: 'alpha', sessions: ['alpha', 'bravo', 'charlie'], liftedPct: undefined },
      { id: 'bravo', sessions: ['bravo', 'charlie'], liftedPct: undefined },
    ]);
    for (const part of parts) {
      near(part.budgetPct, part.sessions.reduce((sum, id) => sum + (dailyBudgetOf(10, id, team) ?? 0), 0), part.id);
    }
    near(parts[0]?.budgetPct, 6, "alpha's group weighs 3 of 5");
  });

  it("gives a lifted group its lift's part of its parent's budget, and a group under it its part of that", () => {
    const parts = groupPartsOf(10, nested({ liftedGroups: new Map([['alpha', 80]]) }));
    assert.deepEqual(shapes(parts).map(({ id, liftedPct }) => [id, liftedPct]), [['alpha', 80], ['bravo', undefined]]);
    near(parts[0]?.budgetPct, 8, 'alpha');
    near(parts[1]?.budgetPct, 16 / 3, "bravo's group weighs 2 of the 3 in alpha's");
    const inner = groupPartsOf(10, nested({ liftedGroups: new Map([['bravo', 50]]) }));
    near(inner[0]?.budgetPct, 6, "a lift inside alpha's group leaves the group's part as it was");
    near(inner[1]?.budgetPct, 3, 'bravo');
  });

  it("splits each group's part out of its team's part beside the other teams on the account", () => {
    const team = nested();
    const web = otherTeam('web', ['lead', 'front']);
    const parts = groupPartsOf(14, team, [web]);
    // App weighs 5 of 7: 10 of 14; alpha's group 3 of app's 5, bravo's 2.
    near(parts[0]?.budgetPct, 6, 'alpha');
    near(parts[1]?.budgetPct, 4, 'bravo');
    for (const part of parts) {
      near(part.budgetPct, part.sessions.reduce((sum, id) => sum + (dailyBudgetOf(14, id, team, [web]) ?? 0), 0), `${part.id} beside web`);
    }
  });

  it("is unknown while the account's day is, and holds no group while no sub-lead on the roster leads", () => {
    assert.deepEqual(groupPartsOf(undefined, nested()).map((part) => part.budgetPct), [undefined, undefined]);
    assert.deepEqual(groupPartsOf(10, split()), []);
    assert.deepEqual(groupPartsOf(10, split({}, { leads: { zulu: ['alpha'] } })), [], 'a sub-lead off the roster');
  });
});

describe('teamPartOf', () => {
  it("is the account's whole day, exactly, while no other team is on the account", () => {
    assert.equal(teamPartOf(9.7, split({ alpha: { share: 3 } })), 9.7);
    assert.equal(teamPartOf(9.7, split(), []), 9.7);
    assert.equal(teamPartOf(undefined, split(), [otherTeam('web', ['lead'])]), undefined);
  });

  it("splits the account's day among its teams by their sessions' weights summed, the parts adding up to the day", () => {
    const app = split();
    const web = otherTeam('web', ['lead', 'front'], { sessions: { front: { share: 2 } } });
    const ops = otherTeam('ops', ['run'], { work: workOf({ run: 4 }) });
    // Weights app 3, web 3, ops 4.
    assert.equal(teamPartOf(15, app, [web, ops]), 4.5);
    assert.equal(teamPartOf(15, web, [app, ops]), 4.5);
    assert.equal(teamPartOf(15, ops, [app, web]), 6);
  });

  it('gives a team whose sessions take no share nothing, the others the whole day', () => {
    const idle = otherTeam('idle', ['lead'], { sessions: { lead: { share: 0 } } });
    assert.equal(teamPartOf(9, idle, [split()]), 0);
    assert.equal(teamPartOf(9, split(), [idle]), 9);
  });
});

describe('teamShareOf', () => {
  it('is all of an amount while the team is alone on the account', () => {
    assert.equal(teamShareOf(7.8, split(), []), 7.8);
  });

  it("splits an account's spare among its teams by weight, a lift inside a team leaving the teams' parts as they were", () => {
    const web = otherTeam('web', ['lead', 'front'], { sessions: { front: { share: 2 } } });
    // Weights app 3, web 3.
    assert.equal(teamShareOf(8, split(), [web]), 4);
    assert.equal(teamShareOf(8, split({}, { lifted: new Map([['alpha', 80]]) }), [web]), 4);
    assert.equal(teamShareOf(8, split({}, { leads: { alpha: ['bravo'] }, liftedGroups: new Map([['alpha', 80]]) }), [web]), 4);
    assert.equal(teamShareOf(8, web, [split()]), 4);
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

describe('teamTreeOf', () => {
  it("puts every session at the top while no sub-lead leads, weighed by its share times its queued work, at least 1, with its lift's part", () => {
    const tree = teamTreeOf(split({ alpha: { share: 2 } }, { work: workOf({ alpha: 3, bravo: 0 }), lifted: new Map([['bravo', 30]]) }));
    assert.deepEqual(tree.nodes, [
      { id: 'lead', liftedPct: undefined, weight: 1 },
      { id: 'alpha', liftedPct: undefined, weight: 6 },
      { id: 'bravo', liftedPct: 30, weight: 1 },
    ]);
    assert.deepEqual([...tree.sessionPaths], [['lead', ['lead']], ['alpha', ['alpha']], ['bravo', ['bravo']]]);
    assert.equal(tree.groupPaths.size, 0);
  });

  it("makes each sub-lead a group of its own leaf and the sessions it lists, at any depth, with its group lift's part", () => {
    const tree = teamTreeOf(nested({ lifted: new Map([['bravo', 40]]), liftedGroups: new Map([['bravo', 25]]) }));
    const at = (id: string, liftedPct?: number): SplitNode => ({ id, liftedPct, weight: 1 });
    assert.deepEqual(tree.nodes, [
      at('lead'),
      { id: 'alpha', liftedPct: undefined, nodes: [at('alpha'), { id: 'bravo', liftedPct: 25, nodes: [at('bravo', 40), at('charlie')] }] },
      at('delta'),
    ]);
    assert.deepEqual(tree.sessionPaths.get('charlie'), ['alpha', 'bravo', 'charlie']);
    assert.deepEqual(tree.sessionPaths.get('bravo'), ['alpha', 'bravo', 'bravo']);
    assert.deepEqual([...tree.groupPaths], [['alpha', ['alpha']], ['bravo', ['alpha', 'bravo']]]);
  });
});

describe('liftPlaceOf', () => {
  const team = split({}, {
    ids: ['lead', 'alpha', 'bravo', 'charlie'],
    leads: { alpha: ['bravo', 'charlie'] },
    lifted: new Map([['lead', 20], ['alpha', 10], ['bravo', 30]]),
    liftedGroups: new Map([['alpha', 50]]),
  });

  it("places a session's lift in its parent's budget beside the other lifts there, its own not counted", () => {
    assert.deepEqual(liftPlaceOf(team, 'lead', false), { parent: undefined, liftedPct: 50 });
    assert.deepEqual(liftPlaceOf(team, 'bravo', false), { parent: 'alpha', liftedPct: 10 });
    assert.deepEqual(liftPlaceOf(team, 'charlie', false), { parent: 'alpha', liftedPct: 40 });
  });

  it("places a sub-lead's own lift in its group's budget, and its group's lift in the budget above", () => {
    assert.deepEqual(liftPlaceOf(team, 'alpha', false), { parent: 'alpha', liftedPct: 30 });
    assert.deepEqual(liftPlaceOf(team, 'alpha', true), { parent: undefined, liftedPct: 20 });
    assert.deepEqual(liftPlaceOf(nested(), 'bravo', true), { parent: 'alpha', liftedPct: 0 });
  });

  it('is undefined for a group no sub-lead leads and for a session the tree does not hold', () => {
    assert.equal(liftPlaceOf(team, 'bravo', true), undefined);
    assert.equal(liftPlaceOf(team, 'zulu', false), undefined);
  });
});

describe('budgetSplitOf', () => {
  const source = { team: 'app', ids: IDS, sessions: {}, leads: { alpha: ['bravo'] }, work: workOf({ bravo: 2 }), now: NOW };

  it("maps each session's and each on-roster sub-lead's group's lift in force to its part", () => {
    const lifts = [
      lift(),
      lift({ session: 'bravo', partPct: 20, endsAt: NOW }),
      lift({ session: 'lead', partPct: 10, stopPct: 50 }),
      lift({ session: 'alpha', group: true, partPct: 40 }),
      lift({ session: 'bravo', group: true, partPct: 30 }),
    ];
    assert.deepEqual(budgetSplitOf({ ...source, lifts, usedPct: 57 }), {
      team: 'app',
      ids: IDS,
      sessions: {},
      leads: { alpha: ['bravo'] },
      work: workOf({ bravo: 2 }),
      lifted: new Map([['alpha', 50]]),
      liftedGroups: new Map([['alpha', 40]]),
    });
    assert.deepEqual([...budgetSplitOf({ ...source, lifts, usedPct: undefined }).lifted], [['lead', 10], ['alpha', 50]]);
  });
});

describe('addedSessionPct', () => {
  it('gives one more session at the default weight its part beside the shares, queued work and lifts', () => {
    const weighted = split({ lead: { share: 2 } }, { work: workOf({ alpha: 3 }) });
    assert.equal(addedSessionPct(10, weighted), 10 / 7, 'weights lead 2, alpha 3, bravo 1, the added session 1');
    assert.equal(addedSessionPct(10, { ...weighted, lifted: new Map([['bravo', 30]]) }), 7 / 6, "bravo's lift takes 30% first");
    assert.equal(addedSessionPct(9, split()), 9 / 4);
    assert.equal(addedSessionPct(9, split(), []), 9 / 4);
  });

  it("takes the added session's part out of its team's, which grows by its weight beside the other teams", () => {
    // App with the added session weighs 4, web 2: app's part is 8 of 12, the added session's a quarter of it.
    assert.equal(addedSessionPct(12, split(), [otherTeam('web', ['lead', 'front'])]), 2);
  });
});
