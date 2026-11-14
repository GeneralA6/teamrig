import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JERUSALEM } from '../testing/zone.ts';
import { EVENT_VERSION, type RegisterEvent, type TaskFields } from './events.ts';
import type { GoalProgress, GoalState, GoalStats } from './goal-stats.ts';
import type { Goal } from './goals.ts';
import type { TaskStatus } from './model.ts';
import { registerStats, type StatsInput, type StatsRange, type StatsScope } from './stats.ts';

const FIELDS: TaskFields = { title: 'Ship it', description: null, owner: 'alpha', source: 'lead', ref: null, priority: 2, due: null, goals: [], noGoal: false, week: null, after: [], size: null, type: null, critical: false, pin: null, workClass: null, local: null };

/** Thursday 2030-01-10 12:00 on the team's clock (UTC+2): a 7 d range runs 01-04 to 01-10, the pace 12-28 to 01-10. */
const NOW = new Date('2030-01-10T10:00:00.000Z');
const CREATED = '2029-10-01T08:00:00.000Z';

function create(id: string, goals: readonly string[], more: Partial<TaskFields> = {}): RegisterEvent {
  return { v: EVENT_VERSION, type: 'create', id, at: CREATED, by: 'lead', task: { ...FIELDS, goals, ...more } };
}

function status(id: string, at: string, value: TaskStatus): RegisterEvent {
  return { v: EVENT_VERSION, type: 'status', id, at, by: 'alpha', status: value, note: 'n', evidence: null, skill: null };
}

function doneTask(id: string, at: string, goals: readonly string[], more: Partial<TaskFields> = {}): RegisterEvent[] {
  return [create(id, goals, more), status(id, at, 'done')];
}

function goal(tag: string, more: Partial<Goal> = {}): Goal {
  return { tag, title: `Goal ${tag}`, start: '2030-01-01', target: '2030-02-01', parent: null, addedAt: CREATED, addedBy: 'lead', slips: [], rank: null, ...more };
}

function input(events: readonly RegisterEvent[], range: StatsRange): StatsInput {
  return { teams: [{ team: 'alpha', lead: 'lead', events }], range, now: NOW, zone: JERUSALEM, ownerMarker: 'owner' };
}

function goalsOf(goals: readonly Goal[], events: readonly RegisterEvent[], range: StatsRange = '7d'): GoalStats {
  return registerStats({ ...input(events, range), goals: new Map(goals.map((each) => [each.tag, each])) }).goals;
}

function progress(stats: GoalStats, tag: string): GoalProgress {
  const found = stats.goals.find((each) => each.tag === tag);
  assert.ok(found, `no goal ${tag}`);
  return found;
}

describe('goal stats: which tasks serve a goal', () => {
  it('rolls a finer tag up to its deepest record and that record\'s parents, and R1.10 is no part of R1.1', () => {
    const stats = goalsOf(
      [goal('R1'), goal('R1.1', { parent: 'R1' }), goal('R1.3', { parent: 'R1' })],
      [create('T1', ['R1.3e']), ...doneTask('T2', '2030-01-09T08:00:00.000Z', ['R1.3']), create('T3', ['R1.10'])],
    );
    assert.deepEqual([progress(stats, 'R1.3').open, progress(stats, 'R1.3').done], [1, 1]);
    assert.deepEqual([progress(stats, 'R1.1').open, progress(stats, 'R1.1').done], [0, 0]);
    assert.deepEqual([progress(stats, 'R1').open, progress(stats, 'R1').done], [2, 1]);
  });

  it('gives a tag with no record of its own to the nearest record above it', () => {
    assert.equal(progress(goalsOf([goal('R1')], [create('T1', ['R1.3'])]), 'R1').open, 1);
  });

  it('counts a task with two tags under one goal once', () => {
    const found = progress(goalsOf([goal('R1.3')], [create('T1', ['R1.3a', 'R1.3b'])]), 'R1.3');
    assert.equal(found.open, 1);
    assert.deepEqual(found.tasks.map(({ task }) => task.id), ['T1']);
  });

  it('stops at a parent cycle', () => {
    const stats = goalsOf([goal('A', { parent: 'B' }), goal('B', { parent: 'A' })], [create('T1', ['A'])]);
    assert.deepEqual([progress(stats, 'A').open, progress(stats, 'B').open], [1, 1]);
  });

  it('counts a dropped task for neither done nor open', () => {
    const found = progress(goalsOf([goal('G1')], [create('T1', ['G1']), status('T1', '2030-01-09T08:00:00.000Z', 'dropped'), ...doneTask('T2', '2030-01-09T08:00:00.000Z', ['G1']), create('T3', ['G1']), status('T3', '2030-01-09T08:00:00.000Z', 'verifying')]), 'G1');
    assert.deepEqual([found.done, found.open], [1, 1]);
  });

  it('lists only the goals with a task in a session scope, and every goal without one', () => {
    const events = [create('T1', ['G1']), create('T2', ['G2'], { owner: 'beta' })];
    const goals = new Map([goal('G1'), goal('G2')].map((each) => [each.tag, each]));
    const session: StatsScope = { team: 'alpha', session: 'alpha' };
    assert.deepEqual(registerStats({ ...input(events, '7d'), goals, session }).goals.goals.map((each) => each.tag), ['G1']);
    assert.deepEqual(registerStats({ ...input(events, '7d'), goals }).goals.goals.map((each) => each.tag), ['G1', 'G2']);
  });
});

describe('goal stats: pace, forecast and days', () => {
  it('forecasts the open tasks at the last 14 days\' pace, and counts the whole history as done', () => {
    const inPace = ['2029-12-28', '2030-01-01', '2030-01-02', '2030-01-03', '2030-01-04', '2030-01-05', '2030-01-10'];
    const events = [...inPace.flatMap((day, n) => doneTask(`T${n + 1}`, `${day}T08:00:00.000Z`, ['G1'])), ...doneTask('T8', '2029-12-27T08:00:00.000Z', ['G1']), create('T9', ['G1']), create('T10', ['G1']), create('T11', ['G1'])];
    const found = progress(goalsOf([goal('G1')], events), 'G1');
    assert.deepEqual([found.done, found.open, found.pace, found.forecast], [8, 3, 0.5, '2030-01-16']);
  });

  it('has no forecast with no pace or with none open', () => {
    assert.equal(progress(goalsOf([goal('G1')], [create('T1', ['G1'])]), 'G1').forecast, null);
    assert.equal(progress(goalsOf([goal('G1')], doneTask('T1', '2030-01-09T08:00:00.000Z', ['G1'])), 'G1').forecast, null);
  });

  it('counts done days on the team\'s calendar, oldest first, leaving the empty days out', () => {
    const events = [...doneTask('T1', '2030-01-08T22:30:00.000Z', ['G1']), ...doneTask('T2', '2030-01-09T08:00:00.000Z', ['G1']), ...doneTask('T3', '2030-01-05T10:00:00.000Z', ['G1'])];
    assert.deepEqual(progress(goalsOf([goal('G1')], events), 'G1').doneDays, [
      { day: '2030-01-05', done: 1 },
      { day: '2030-01-09', done: 2 },
    ]);
  });
});

describe('goal stats: state', () => {
  const open = create('T1', ['G1']);
  const paceOfOne = doneTask('T2', '2030-01-09T08:00:00.000Z', ['G1']);
  const cases: readonly { readonly name: string; readonly goal: Partial<Goal>; readonly events: readonly RegisterEvent[]; readonly state: GoalState }[] = [
    { name: 'all closed is done, past its target too', goal: { target: '2030-01-01' }, events: paceOfOne, state: 'done' },
    { name: 'past the target with work open is late', goal: { target: '2030-01-09' }, events: [open, ...paceOfOne], state: 'late' },
    { name: 'past the target with no tasks is late', goal: { target: '2030-01-09' }, events: [], state: 'late' },
    { name: 'no tasks before the target is on track', goal: {}, events: [], state: 'on track' },
    { name: 'no pace before the start is on track', goal: { start: '2030-02-01', target: '2030-03-01' }, events: [open], state: 'on track' },
    { name: 'no pace after the start is at risk', goal: {}, events: [open], state: 'at risk' },
    { name: 'no pace on the target day is at risk, not late', goal: { target: '2030-01-10' }, events: [open], state: 'at risk' },
    { name: 'a forecast on the target is on track', goal: { target: '2030-01-24' }, events: [open, ...paceOfOne], state: 'on track' },
    { name: 'a forecast past the target is at risk', goal: { target: '2030-01-23' }, events: [open, ...paceOfOne], state: 'at risk' },
  ];
  for (const each of cases) {
    it(each.name, () => {
      assert.equal(progress(goalsOf([goal('G1', each.goal)], each.events), 'G1').state, each.state);
    });
  }
});

describe('goal stats: off goal', () => {
  const inRange = '2030-01-09T08:00:00.000Z';

  it('counts the tasks done in the range with no tag: a tag with no record still served a goal', () => {
    const events = [...doneTask('T1', inRange, []), ...doneTask('T2', inRange, [], { noGoal: true }), ...doneTask('T3', inRange, ['X9']), ...doneTask('T4', inRange, ['G1']), ...doneTask('T5', '2029-12-01T08:00:00.000Z', []), create('T6', [])];
    const stats = goalsOf([goal('G1')], events);
    assert.deepEqual([stats.offGoal, stats.doneInRange], [2, 4]);
  });

  it('counts them with no goal records read, listing no goals', () => {
    const stats = registerStats(input(doneTask('T1', inRange, []), '7d')).goals;
    assert.deepEqual([stats.goals, stats.offGoal, stats.doneInRange], [[], 1, 1]);
  });
});
